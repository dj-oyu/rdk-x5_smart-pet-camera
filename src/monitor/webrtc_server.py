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
    logger.debug(f"Received WebRTC offer: sdp_length={len(offer_data.get('sdp', ''))}")

    # Create unique ID for this peer connection
    pc_id = str(uuid.uuid4())

    # Create RTCPeerConnection
    pc = RTCPeerConnection()
    pcs[pc_id] = pc

    logger.info(f"WebRTC peer connection created: {pc_id[:8]}")

    # Set up connection state handlers
    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        logger.debug(f"Connection state {pc_id[:8]}: {pc.connectionState}")
        if pc.connectionState == "failed" or pc.connectionState == "closed":
            await cleanup_pc(pc_id)

    @pc.on("iceconnectionstatechange")
    async def on_iceconnectionstatechange():
        logger.debug(f"ICE state {pc_id[:8]}: {pc.iceConnectionState}")
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
    logger.debug(f"Remote description set for {pc_id[:8]}")

    # THEN add track after remote description is set
    # Create H.264 video track
    h264_track = H264StreamTrack()

    # Add track to peer connection
    # Use relay to allow multiple clients to receive the same stream
    pc.addTrack(relay.subscribe(h264_track))
    logger.debug(f"Video track added to {pc_id[:8]}")

    # Create answer
    answer = await pc.createAnswer()
    logger.debug(f"Answer created for {pc_id[:8]}")

    # Set local description (our answer)
    await pc.setLocalDescription(answer)
    logger.debug(f"Local description set for {pc_id[:8]}")

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

    logger.debug(f"ICE candidate received for {pc_id[:8]}")

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
        logger.debug(f"Cleaned up peer connection {pc_id[:8]}")


async def cleanup_all_pcs():
    """Cleanup all peer connections."""
    for pc_id in list(pcs.keys()):
        await cleanup_pc(pc_id)
    logger.debug("Cleaned up all peer connections")
