"""
WebRTC Signaling Server

This module provides WebRTC signaling endpoints for establishing peer connections.
"""

import asyncio
import json
import logging
import uuid
from typing import Dict

from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaRelay

from h264_track import H264StreamTrack

logger = logging.getLogger(__name__)

# Global storage for peer connections
pcs: Dict[str, RTCPeerConnection] = {}

# Media relay for efficient multi-client streaming
relay = MediaRelay()


async def handle_offer(offer_data: dict) -> dict:
    """
    Handle WebRTC offer and create answer.

    Args:
        offer_data: Dictionary containing 'sdp' and 'type' from client

    Returns:
        Dictionary containing answer 'sdp' and 'type'
    """
    print(f"[WebRTC Server] Received offer: type={offer_data.get('type')}, sdp_length={len(offer_data.get('sdp', ''))}")
    logger.info(f"Received WebRTC offer: type={offer_data.get('type')}, sdp_length={len(offer_data.get('sdp', ''))}")

    # Create unique ID for this peer connection
    pc_id = str(uuid.uuid4())

    # Create RTCPeerConnection
    pc = RTCPeerConnection()
    pcs[pc_id] = pc

    print(f"[WebRTC Server] Created peer connection {pc_id}")
    logger.info(f"Created peer connection {pc_id}")

    # Set up connection state handlers
    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        print(f"[WebRTC Server] Connection state for {pc_id}: {pc.connectionState}")
        logger.info(f"Connection state for {pc_id}: {pc.connectionState}")
        if pc.connectionState == "failed" or pc.connectionState == "closed":
            await cleanup_pc(pc_id)

    @pc.on("iceconnectionstatechange")
    async def on_iceconnectionstatechange():
        print(f"[WebRTC Server] ICE connection state for {pc_id}: {pc.iceConnectionState}")
        logger.info(f"ICE connection state for {pc_id}: {pc.iceConnectionState}")
        if pc.iceConnectionState == "failed" or pc.iceConnectionState == "closed":
            await cleanup_pc(pc_id)

    # Parse offer
    try:
        offer = RTCSessionDescription(sdp=offer_data["sdp"], type=offer_data["type"])
    except Exception as e:
        logger.error(f"Failed to parse offer: {e}")
        raise

    # Set remote description (client's offer) FIRST
    await pc.setRemoteDescription(offer)
    print(f"[WebRTC Server] Remote description set for {pc_id}")
    logger.info(f"Remote description set for {pc_id}")

    # THEN add track after remote description is set
    # Create H.264 video track
    print(f"[WebRTC Server] Creating H264StreamTrack...")
    h264_track = H264StreamTrack()

    # Add track to peer connection
    # Use relay to allow multiple clients to receive the same stream
    print(f"[WebRTC Server] Adding video track to peer connection...")
    pc.addTrack(relay.subscribe(h264_track))
    print(f"[WebRTC Server] Video track added to {pc_id}")
    logger.info(f"Video track added to {pc_id}")

    # Create answer
    print(f"[WebRTC Server] Creating answer...")
    answer = await pc.createAnswer()
    print(f"[WebRTC Server] Answer created for {pc_id}")
    logger.info(f"Answer created for {pc_id}")

    # Set local description (our answer)
    await pc.setLocalDescription(answer)
    print(f"[WebRTC Server] Local description set for {pc_id}")
    logger.info(f"Local description set for {pc_id}")

    # Return answer to client
    return {
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type,
        "pc_id": pc_id
    }


async def handle_ice_candidate(pc_id: str, candidate_data: dict) -> dict:
    """
    Handle ICE candidate from client.

    Args:
        pc_id: Peer connection ID
        candidate_data: ICE candidate data

    Returns:
        Status dictionary
    """
    if pc_id not in pcs:
        logger.warning(f"ICE candidate received for unknown peer connection {pc_id}")
        return {"status": "error", "message": "Unknown peer connection"}

    pc = pcs[pc_id]

    # Note: aiortc handles ICE candidates automatically during offer/answer exchange
    # This endpoint is optional for trickle ICE support

    logger.info(f"ICE candidate received for {pc_id}")

    return {"status": "ok"}


async def cleanup_pc(pc_id: str):
    """
    Cleanup peer connection.

    Args:
        pc_id: Peer connection ID
    """
    if pc_id in pcs:
        pc = pcs[pc_id]
        await pc.close()
        del pcs[pc_id]
        logger.info(f"Cleaned up peer connection {pc_id}")


async def cleanup_all_pcs():
    """Cleanup all peer connections."""
    for pc_id in list(pcs.keys()):
        await cleanup_pc(pc_id)
    logger.info("Cleaned up all peer connections")
