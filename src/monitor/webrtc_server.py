"""
WebRTC Signaling Server

aiohttpベースのWebRTCシグナリングサーバー
SDP offer/answer exchange and ICE candidate handling
"""

from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer
from aiortc.contrib.media import MediaBlackhole
import json
import logging
import sys
from pathlib import Path
from typing import Dict, Set

# H.264トラック
from h264_track import H264StreamTrack

# 共有メモリアクセス
sys.path.insert(0, str(Path(__file__).parent.parent / "capture"))
from real_shared_memory import RealSharedMemory

logger = logging.getLogger(__name__)


class WebRTCServer:
    """
    WebRTCシグナリングサーバー

    Attributes:
        shm: H.264ストリーム用共有メモリ
        peers: アクティブなRTCPeerConnection のセット
        app: aiohttpアプリケーション
    """

    def __init__(self, h264_shm: RealSharedMemory, host: str = "0.0.0.0", port: int = 8081):
        """
        Initialize WebRTC server

        Args:
            h264_shm: Shared memory for H.264 stream
            host: Server host (default: 0.0.0.0)
            port: Server port (default: 8081)
        """
        self.shm = h264_shm
        self.host = host
        self.port = port

        # Active peer connections
        self.peers: Set[RTCPeerConnection] = set()

        # Create aiohttp app
        self.app = web.Application()
        self._setup_routes()

        logger.info(f"WebRTC server initialized on {host}:{port}")

    def _setup_routes(self):
        """Setup HTTP routes"""
        self.app.router.add_post('/api/webrtc/offer', self.handle_offer)
        self.app.router.add_post('/api/webrtc/ice', self.handle_ice)
        self.app.router.add_get('/api/webrtc/status', self.handle_status)

        # CORS support
        self.app.router.add_route('OPTIONS', '/api/webrtc/offer', self.handle_options)
        self.app.router.add_route('OPTIONS', '/api/webrtc/ice', self.handle_options)

        # Cleanup on shutdown
        self.app.on_shutdown.append(self.on_shutdown)

    async def handle_options(self, request: web.Request) -> web.Response:
        """Handle OPTIONS request (CORS preflight)"""
        return web.Response(
            headers={
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            }
        )

    async def handle_offer(self, request: web.Request) -> web.Response:
        """
        Handle WebRTC offer from client

        Expects JSON: {"sdp": "...", "type": "offer"}
        Returns JSON: {"sdp": "...", "type": "answer"}
        """
        try:
            params = await request.json()
            logger.info("Received WebRTC offer")

            # Parse SDP offer
            offer_sdp = params.get("sdp")
            offer_type = params.get("type")

            if not offer_sdp or offer_type != "offer":
                return web.Response(
                    status=400,
                    text="Invalid offer",
                    headers={'Access-Control-Allow-Origin': '*'}
                )

            offer = RTCSessionDescription(sdp=offer_sdp, type=offer_type)

            # Create peer connection
            pc = RTCPeerConnection(
                configuration=RTCConfiguration(
                    iceServers=[
                        RTCIceServer(urls=["stun:stun.l.google.com:19302"])
                    ]
                )
            )
            self.peers.add(pc)

            # Add H.264 video track
            video_track = H264StreamTrack(self.shm, fps=30)
            pc.addTrack(video_track)
            logger.info("Added H.264 video track to peer connection")

            # Handle connection state changes
            @pc.on("connectionstatechange")
            async def on_connectionstatechange():
                logger.info(f"Connection state: {pc.connectionState}")
                if pc.connectionState in ["failed", "closed"]:
                    await self.cleanup_peer(pc)

            # Handle ICE connection state
            @pc.on("iceconnectionstatechange")
            async def on_iceconnectionstatechange():
                logger.info(f"ICE connection state: {pc.iceConnectionState}")

            # Set remote description (offer)
            await pc.setRemoteDescription(offer)

            # Create answer
            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)

            logger.info("Created WebRTC answer")

            # Return answer
            return web.Response(
                content_type="application/json",
                text=json.dumps({
                    "sdp": pc.localDescription.sdp,
                    "type": pc.localDescription.type
                }),
                headers={'Access-Control-Allow-Origin': '*'}
            )

        except Exception as e:
            logger.error(f"Error handling offer: {e}")
            import traceback
            traceback.print_exc()
            return web.Response(
                status=500,
                text=f"Server error: {str(e)}",
                headers={'Access-Control-Allow-Origin': '*'}
            )

    async def handle_ice(self, request: web.Request) -> web.Response:
        """
        Handle ICE candidate from client

        Expects JSON: {"candidate": "...", "sdpMid": "...", "sdpMLineIndex": 0}
        """
        try:
            params = await request.json()
            logger.info("Received ICE candidate")

            # Note: In a production setup, we'd need to match this to a specific peer
            # For now, we accept but don't use it (STUN should be sufficient for local testing)

            return web.Response(
                status=200,
                text="OK",
                headers={'Access-Control-Allow-Origin': '*'}
            )

        except Exception as e:
            logger.error(f"Error handling ICE: {e}")
            return web.Response(
                status=500,
                text=f"Server error: {str(e)}",
                headers={'Access-Control-Allow-Origin': '*'}
            )

    async def handle_status(self, request: web.Request) -> web.Response:
        """Return server status"""
        status = {
            "peers": len(self.peers),
            "running": True,
        }
        return web.Response(
            content_type="application/json",
            text=json.dumps(status),
            headers={'Access-Control-Allow-Origin': '*'}
        )

    async def cleanup_peer(self, pc: RTCPeerConnection):
        """Cleanup peer connection"""
        logger.info("Cleaning up peer connection")
        self.peers.discard(pc)
        await pc.close()

    async def on_shutdown(self, app: web.Application):
        """Cleanup on server shutdown"""
        logger.info("Shutting down WebRTC server, closing all peers")
        coros = [self.cleanup_peer(pc) for pc in list(self.peers)]
        if coros:
            import asyncio
            await asyncio.gather(*coros)

    def run(self):
        """Run the server"""
        logger.info(f"Starting WebRTC server on {self.host}:{self.port}")
        web.run_app(self.app, host=self.host, port=self.port)


async def create_app(h264_shm: RealSharedMemory) -> web.Application:
    """
    Create aiohttp application (for integration with existing setup)

    Args:
        h264_shm: Shared memory for H.264 stream

    Returns:
        aiohttp Application
    """
    server = WebRTCServer(h264_shm)
    return server.app


if __name__ == "__main__":
    # Standalone server for testing
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

    # Open H.264 shared memory
    shm = RealSharedMemory(frame_shm_name="/pet_camera_stream")
    try:
        shm.open()
        logger.info("H.264 shared memory opened")

        # Create and run server
        server = WebRTCServer(shm, host="0.0.0.0", port=8081)
        server.run()

    except KeyboardInterrupt:
        logger.info("Server stopped by user")
    except Exception as e:
        logger.error(f"Server error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        shm.close()
