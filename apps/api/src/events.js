// Server-Sent Events hub. Clients subscribe to everything; payloads carry
// enough context (taskId/projectId) for the UI to filter.
const clients = new Set();

export function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':ok\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

export function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}
