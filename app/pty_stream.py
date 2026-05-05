"""PTY Streaming Backend — pseudo-terminal streaming for embedded terminal.

Provides WindSurf/Cascade-like embedded terminal experience:
- PTY (pseudo-terminal) creation and management
- Real-time output streaming via WebSocket
- Interactive input handling (passwords, prompts)
- Session management for multiple concurrent terminals
"""
import asyncio
import json
import logging
import os
import pty
import select
import signal
import subprocess
import termios
import tty
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ide", tags=["ide-terminal"])


class PTYSession:
    def __init__(self, session_id: str, cwd: str = None, shell: str = None):
        self.id = session_id
        self.cwd = cwd or os.getcwd()
        self.shell = shell or os.environ.get('SHELL', '/bin/bash')
        self.pid: Optional[int] = None
        self.fd: Optional[int] = None
        self.active = False
        self.output_queue = asyncio.Queue()
        self.input_queue = asyncio.Queue()
        self.reader_task: Optional[asyncio.Task] = None

    def start(self):
        """Start the PTY session."""
        self.pid, self.fd = pty.fork()
        
        if self.pid == 0:  # Child process
            os.chdir(self.cwd)
            os.execvp(self.shell, [self.shell])
        else:  # Parent process
            self.active = True
            # Set terminal to raw mode for proper input handling
            attrs = termios.tcgetattr(self.fd)
            attrs[1] &= ~termios.IGNBRK  # Disable break handling
            attrs[3] &= ~(termios.ECHO | termios.ICANON)  # No echo, raw mode
            termios.tcsetattr(self.fd, termios.TCSAFLUSH, attrs)

    def stop(self):
        """Stop the PTY session."""
        if self.active:
            self.active = False
            if self.pid:
                try:
                    os.kill(self.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            if self.fd:
                try:
                    os.close(self.fd)
                except OSError:
                    pass

    async def read_output(self):
        """Read output from PTY and queue it."""
        while self.active and self.fd:
            try:
                # Wait for data to be available
                r, _, _ = select.select([self.fd], [], [], 0.1)
                if r:
                    data = os.read(self.fd, 4096)
                    if data:
                        await self.output_queue.put(data.decode('utf-8', errors='ignore'))
            except OSError:
                break
            except Exception as e:
                logger.error(f"PTY read error: {e}")
                break

    async def write_input(self, data: str):
        """Write input to PTY."""
        if self.active and self.fd:
            try:
                os.write(self.fd, data.encode('utf-8'))
            except OSError as e:
                logger.error(f"PTY write error: {e}")


# Active PTY sessions
_pty_sessions: Dict[str, PTYSession] = {}


@router.websocket("/terminal-stream/{session_id}")
async def terminal_stream(websocket: WebSocket, session_id: str):
    """WebSocket endpoint for terminal streaming."""
    await websocket.accept()
    
    session = _pty_sessions.get(session_id)
    if not session:
        await websocket.send_json({"type": "error", "message": "Session not found"})
        await websocket.close()
        return
    
    # Start output reader task
    reader_task = asyncio.create_task(session.read_output())
    
    try:
        # Send output to client
        async def output_sender():
            while session.active:
                try:
                    output = await asyncio.wait_for(session.output_queue.get(), timeout=0.1)
                    await websocket.send_json({"type": "output", "content": output})
                except asyncio.TimeoutError:
                    continue
                except Exception as e:
                    logger.error(f"Output sender error: {e}")
                    break
        
        sender_task = asyncio.create_task(output_sender())
        
        # Receive input from client
        while True:
            try:
                data = await websocket.receive_text()
                message = json.loads(data)
                
                if message.get("type") == "input":
                    await session.write_input(message.get("content", ""))
                elif message.get("type") == "resize":
                    # Handle terminal resize (would need pty.setwinsize)
                    pass
            except WebSocketDisconnect:
                break
            except Exception as e:
                logger.error(f"WebSocket error: {e}")
                break
    finally:
        reader_task.cancel()
        if 'sender_task' in locals():
            sender_task.cancel()


@router.post("/terminal-create")
async def create_terminal(cwd: str = None, shell: str = None):
    """Create a new PTY session."""
    session_id = str(uuid.uuid4())[:12]
    session = PTYSession(session_id, cwd, shell)
    session.start()
    _pty_sessions[session_id] = session
    
    # Start output reader
    session.reader_task = asyncio.create_task(session.read_output())
    
    return {"session_id": session_id, "cwd": cwd, "shell": shell}


@router.post("/terminal-send")
async def send_to_terminal(session_id: str, input: str):
    """Send input to a terminal session."""
    session = _pty_sessions.get(session_id)
    if not session:
        return {"error": "Session not found"}
    
    await session.write_input(input)
    return {"success": True}


@router.post("/terminal-close")
async def close_terminal(session_id: str):
    """Close a terminal session."""
    session = _pty_sessions.get(session_id)
    if session:
        session.stop()
        if session.reader_task:
            session.reader_task.cancel()
        del _pty_sessions[session_id]
    
    return {"success": True}


@router.get("/terminal-list")
async def list_terminals():
    """List active terminal sessions."""
    return {
        "sessions": [
            {
                "session_id": sid,
                "cwd": session.cwd,
                "shell": session.shell,
                "active": session.active
            }
            for sid, session in _pty_sessions.items()
        ]
    }
