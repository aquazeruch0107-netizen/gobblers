export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      // WebSocket handling
    }

    return env.ASSETS.fetch(request);
  }
}

export class RoomDO {
  // Durable Object
}

