"""
WebRTC H.264 Video Track

共有メモリからH.264ストリームを読み取り、WebRTCで配信するカスタムMediaStreamTrack
"""

from aiortc import MediaStreamTrack
from aiortc.mediastreams import MediaStreamError
from av import VideoFrame, CodecContext
import asyncio
import time
import sys
from pathlib import Path
from typing import Optional
import logging

# 共有メモリアクセス用
sys.path.insert(0, str(Path(__file__).parent.parent / "capture"))
from real_shared_memory import RealSharedMemory, Frame

logger = logging.getLogger(__name__)


class H264StreamTrack(MediaStreamTrack):
    """
    共有メモリ(/pet_camera_stream)からH.264ストリームを読み取り、
    WebRTCで配信するカスタムビデオトラック

    Attributes:
        shm: 共有メモリインターフェース
        fps: ターゲットフレームレート（デフォルト30fps）
        codec: H.264コーデックコンテキスト
    """

    kind = "video"

    def __init__(self, shm: RealSharedMemory, fps: int = 30):
        """
        Initialize H.264 stream track

        Args:
            shm: RealSharedMemory instance for H.264 stream
            fps: Target frame rate (default: 30)
        """
        super().__init__()
        self.shm = shm
        self.fps = fps
        self.frame_duration = 1.0 / fps  # seconds per frame

        # Timing control
        self.start_time: Optional[float] = None
        self.frame_count = 0
        self.last_frame_number = -1

        # H.264 codec setup
        self.codec: Optional[CodecContext] = None
        self._setup_codec()

        logger.info(f"H264StreamTrack initialized (fps={fps})")

    def _setup_codec(self):
        """Initialize H.264 codec context"""
        try:
            # Create H.264 decoder context
            # Note: We're receiving already-encoded H.264 from shared memory,
            # but we need to decode it to create VideoFrame for WebRTC
            self.codec = CodecContext.create('h264', 'r')
            logger.info("H.264 codec context created")
        except Exception as e:
            logger.error(f"Failed to create codec context: {e}")
            self.codec = None

    async def recv(self) -> VideoFrame:
        """
        Receive next video frame (called by WebRTC)

        Returns:
            VideoFrame: Next video frame for WebRTC transmission

        Raises:
            MediaStreamError: If track is stopped or frame unavailable
        """
        if self.readyState != "live":
            raise MediaStreamError("Track is not live")

        # Initialize timing on first frame
        if self.start_time is None:
            self.start_time = time.time()
            logger.info("H264StreamTrack started streaming")

        # Frame rate control: wait until next frame time
        target_time = self.start_time + (self.frame_count * self.frame_duration)
        now = time.time()
        wait_time = target_time - now

        if wait_time > 0:
            await asyncio.sleep(wait_time)
        elif wait_time < -self.frame_duration:
            # We're falling behind, log warning
            logger.warning(f"Frame timing behind by {-wait_time:.3f}s")

        # Get latest H.264 frame from shared memory
        frame = await self._get_h264_frame()

        if frame is None:
            # No frame available, return black frame
            logger.warning("No H.264 frame available, using fallback")
            video_frame = self._create_black_frame()
        else:
            # Decode H.264 to VideoFrame
            video_frame = await self._decode_h264_frame(frame)

        # Set WebRTC timestamp (in 90kHz units for video)
        pts = int(self.frame_count * 90000 / self.fps)
        video_frame.pts = pts
        video_frame.time_base = (1, 90000)

        self.frame_count += 1
        return video_frame

    async def _get_h264_frame(self) -> Optional[Frame]:
        """
        Get latest H.264 frame from shared memory

        Returns:
            Frame object or None if unavailable
        """
        try:
            # Read from shared memory (non-blocking)
            frame = self.shm.get_latest_frame()

            if frame is None:
                return None

            # Verify it's an H.264 frame
            if frame.format != 3:  # 3 = H.264
                logger.warning(f"Unexpected frame format: {frame.format} (expected 3 for H.264)")
                return None

            # Skip duplicate frames
            if frame.frame_number == self.last_frame_number:
                return None

            self.last_frame_number = frame.frame_number
            return frame

        except Exception as e:
            logger.error(f"Error reading H.264 frame: {e}")
            return None

    async def _decode_h264_frame(self, frame: Frame) -> VideoFrame:
        """
        Decode H.264 frame data to VideoFrame

        Args:
            frame: H.264 frame from shared memory

        Returns:
            Decoded VideoFrame
        """
        try:
            if self.codec is None:
                logger.error("Codec not initialized")
                return self._create_black_frame()

            # Parse H.264 data
            # Note: frame.data contains H.264 NAL units
            # We need to feed them to the decoder

            # For now, create a simple VideoFrame
            # TODO: Proper H.264 decoding or pass-through

            # Create YUV frame (placeholder)
            # In a real implementation, we would decode the H.264 data
            # or pass it directly to WebRTC if supported

            video_frame = VideoFrame(width=frame.width, height=frame.height, format='yuv420p')

            # Fill with placeholder data
            # TODO: Replace with actual decoded frame
            for plane in video_frame.planes:
                plane.update(bytes(plane.buffer_size))

            return video_frame

        except Exception as e:
            logger.error(f"Error decoding H.264 frame: {e}")
            return self._create_black_frame()

    def _create_black_frame(self) -> VideoFrame:
        """
        Create a black video frame as fallback

        Returns:
            VideoFrame: Black frame (640x480)
        """
        # Create black YUV420p frame
        video_frame = VideoFrame(width=640, height=480, format='yuv420p')

        # Fill Y plane with 0 (black)
        # Fill U/V planes with 128 (neutral chroma)
        for i, plane in enumerate(video_frame.planes):
            fill_value = 128 if i > 0 else 0
            plane.update(bytes([fill_value] * plane.buffer_size))

        return video_frame

    def stop(self):
        """Stop the track"""
        super().stop()
        logger.info("H264StreamTrack stopped")


if __name__ == "__main__":
    # Simple test
    import sys

    logging.basicConfig(level=logging.INFO)

    # Open shared memory
    shm = RealSharedMemory(frame_shm_name="/pet_camera_stream")
    try:
        shm.open()
        logger.info("Shared memory opened")

        # Create track
        track = H264StreamTrack(shm, fps=30)

        # Test receiving a few frames
        async def test():
            for i in range(10):
                frame = await track.recv()
                logger.info(f"Received frame {i}: {frame.width}x{frame.height}, pts={frame.pts}")
                await asyncio.sleep(0.03)  # ~30fps

        asyncio.run(test())

    except Exception as e:
        logger.error(f"Test failed: {e}")
        import traceback
        traceback.print_exc()
    finally:
        shm.close()
