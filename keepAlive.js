const http = require('http');

function startKeepAlive() {
  const port = Number(process.env.PORT || 3000);

  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, service: 'eggies-bot' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });

  server.listen(port, () => {
    console.log(`Keep-alive server listening on port ${port}`);
  });

  return server;
}

module.exports = {
  startKeepAlive
};
