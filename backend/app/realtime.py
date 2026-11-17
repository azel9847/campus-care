import asyncio

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[int, tuple[int, str, WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, user_id: int, role: str, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self.connections[id(websocket)] = (user_id, role, websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self.connections.pop(id(websocket), None)

    async def disconnect_user(self, user_id: int) -> None:
        async with self._lock:
            sockets = [socket for connected_user, _, socket in self.connections.values() if connected_user == user_id]
        for socket in sockets:
            try:
                await socket.close(code=1008)
            except (WebSocketDisconnect, RuntimeError, OSError):
                pass
            await self.disconnect(socket)

    async def publish(self, roles: set[str], user_ids: set[int], event: dict) -> None:
        async with self._lock:
            targets = [
                socket
                for connected_user, connection_role, socket in self.connections.values()
                if connection_role in roles or connected_user in user_ids
            ]
        failed: list[WebSocket] = []
        for socket in targets:
            try:
                await socket.send_json(event)
            except (WebSocketDisconnect, RuntimeError, OSError):
                failed.append(socket)
        for socket in failed:
            await self.disconnect(socket)


manager = ConnectionManager()

