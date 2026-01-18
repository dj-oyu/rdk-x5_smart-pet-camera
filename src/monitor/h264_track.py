"""
H.264 Video Track for WebRTC

This module provides a MediaStreamTrack implementation that reads H.264 NAL units
from shared memory and streams them to WebRTC clients.
"""

import asyncio
import logging
import time
from typing import Optional

import av
from aiortc import MediaStreamTrack
from aiortc.mediastreams import VIDEO_TIME_BASE
from av import VideoFrame

# Import from parent directory
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "capture"))
from real_shared_memory import RealSharedMemory, SHM_NAME_STREAM

logger = logging.getLogger(__name__)


class H264StreamTrack(MediaStreamTrack):
    """
    WebRTC video track that reads H.264 stream from shared memory.

    This track reads H.264 NAL units from the shared memory buffer
    and converts them to WebRTC-compatible video frames.
    """

    kind = "video"

    def __init__(self, shm: Optional[RealSharedMemory] = None, fps: int = 30):
        """
        Initialize H.264 stream track.

        Args:
            shm: Shared memory instance (creates one if None)
            fps: Target frame rate (default: 30)
        """
        super().__init__()

        # Shared memory for H.264 stream
        if shm is None:
            self.shm = RealSharedMemory(frame_shm_name=SHM_NAME_STREAM)
            self.shm.open()
            self._owns_shm = True
        else:
            self.shm = shm
            self._owns_shm = False

        # Frame timing
        self.fps = fps
        self.frame_duration = 1.0 / fps  # seconds per frame
        self.start_time: Optional[float] = None
        self.frame_count = 0

        # Last processed frame number (to avoid duplicates)
        self.last_frame_number = -1

        # Codec context for H.264 decoding (if needed)
        self.codec: Optional[av.CodecContext] = None

        print(f"[H264Track] Initialized (fps={fps}, shm={self.shm.frame_shm_name})")
        logger.info(f"H264StreamTrack initialized (fps={fps})")

    async def recv(self) -> VideoFrame:
        """
        Receive the next video frame.

        This method is called by aiortc to get the next frame for WebRTC transmission.

        Returns:
            VideoFrame: Next video frame
        """
        if self.start_time is None:
            self.start_time = time.time()

        # Calculate target time for this frame
        target_time = self.start_time + (self.frame_count * self.frame_duration)
        now = time.time()

        # Wait if we're ahead of schedule
        if target_time > now:
            await asyncio.sleep(target_time - now)

        # Read H.264 frame from shared memory
        frame = None
        retry_count = 0
        max_retries = 3

        while frame is None and retry_count < max_retries:
            raw_frame = self.shm.read_latest_frame()

            if raw_frame is None:
                retry_count += 1
                logger.warning(f"No frame available from shared memory (retry {retry_count}/{max_retries})")
                await asyncio.sleep(0.01)  # 10ms wait
                continue

            # Check if this is a new frame
            if raw_frame.frame_number == self.last_frame_number:
                # Same frame, wait a bit for new data
                await asyncio.sleep(0.01)
                retry_count += 1
                continue

            # Check format (should be H.264)
            if raw_frame.format != 3:  # FrameFormat.H264
                logger.warning(f"Frame format is {raw_frame.format}, expected H.264 (3)")
                await asyncio.sleep(0.01)
                retry_count += 1
                continue

            frame = raw_frame
            self.last_frame_number = raw_frame.frame_number

        if frame is None:
            # No frame available, create a black frame
            logger.warning("Failed to get frame after retries, returning black frame")
            video_frame = VideoFrame(width=640, height=480)
            video_frame.pts = self.frame_count
            video_frame.time_base = VIDEO_TIME_BASE
            self.frame_count += 1
            return video_frame

        # Convert H.264 data to VideoFrame
        try:
            video_frame = self._create_video_frame(bytes(frame.data), frame.width, frame.height)
            self.frame_count += 1
            logger.debug(f"Frame {self.frame_count} sent (frame_number={frame.frame_number}, size={len(frame.data)} bytes)")
            return video_frame

        except Exception as e:
            logger.error(f"Error creating video frame: {e}", exc_info=True)
            # Return black frame on error
            video_frame = VideoFrame(width=640, height=480)
            video_frame.pts = self.frame_count
            video_frame.time_base = VIDEO_TIME_BASE
            self.frame_count += 1
            return video_frame

    def _create_video_frame(self, h264_data: bytes, width: int, height: int) -> VideoFrame:
        """
        Create a VideoFrame from H.264 data.

        For H.264 streaming in WebRTC, we can pass the encoded data directly
        without decoding. aiortc will handle the RTP packetization.

        Args:
            h264_data: Raw H.264 NAL units
            width: Frame width
            height: Frame height

        Returns:
            VideoFrame with encoded H.264 data
        """
        # Create a packet with H.264 data
        packet = av.Packet(h264_data)

        # For H.264 passthrough, we create a frame with the encoded data
        # aiortc will handle RTP packetization
        video_frame = VideoFrame(width=width, height=height)
        video_frame.pts = self.frame_count
        video_frame.time_base = VIDEO_TIME_BASE

        # Note: For true H.264 passthrough in WebRTC, we would need to use
        # a different approach. For now, we'll decode and re-encode, which
        # is suboptimal but ensures compatibility.

        # Initialize codec if not done
        if self.codec is None:
            self.codec = av.CodecContext.create('h264', 'r')

        # Decode H.264 to raw frame
        try:
            frames = self.codec.decode(packet)
            if frames:
                decoded_frame = frames[0]
                decoded_frame.pts = self.frame_count
                decoded_frame.time_base = VIDEO_TIME_BASE
                return decoded_frame
            else:
                # No frame decoded yet (waiting for keyframe)
                logger.debug("No frame decoded (waiting for keyframe?)")
                video_frame = VideoFrame(width=width, height=height)
                video_frame.pts = self.frame_count
                video_frame.time_base = VIDEO_TIME_BASE
                return video_frame

        except av.AVError as e:
            logger.warning(f"H.264 decode error: {e}")
            video_frame = VideoFrame(width=width, height=height)
            video_frame.pts = self.frame_count
            video_frame.time_base = VIDEO_TIME_BASE
            return video_frame

    def stop(self):
        """Stop the track and cleanup resources."""
        super().stop()

        if self._owns_shm and self.shm:
            self.shm.close()

        logger.info("H264StreamTrack stopped")
