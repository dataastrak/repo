require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ─── Simple in-memory cache (5 min TTL) ───────────────
let reposCache = null;
let reposCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function fetchGitHubRepos() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/user/repos?affiliation=owner&per_page=100&sort=created&direction=desc',
      method: 'GET',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'Astrak-Tools-Dashboard',
        'Accept': 'application/vnd.github.v3+json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const repos = JSON.parse(data);
          if (!Array.isArray(repos)) {
            reject(new Error('GitHub API returned non-array: ' + data.substring(0, 200)));
            return;
          }
          // Return only safe fields (no token exposure)
          const safe = repos.map(r => ({
            name: r.name,
            description: r.description,
            pushed_at: r.pushed_at,
            created_at: r.created_at,
            html_url: r.html_url,
            default_branch: r.default_branch,
            language: r.language,
            private: r.private,
          }));
          resolve(safe);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── HTTP Server ──────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // API: List repos (proxied through server with token)
  if (url.pathname === '/api/repos') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!GITHUB_TOKEN) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'GITHUB_TOKEN not configured' }));
      return;
    }

    try {
      const now = Date.now();
      if (reposCache && (now - reposCacheTime) < CACHE_TTL) {
        res.writeHead(200);
        res.end(JSON.stringify(reposCache));
        return;
      }

      const repos = await fetchGitHubRepos();
      reposCache = repos;
      reposCacheTime = now;

      res.writeHead(200);
      res.end(JSON.stringify(repos));
    } catch (err) {
      console.error('GitHub API error:', err.message);
      // Serve stale cache if available
      if (reposCache) {
        res.writeHead(200);
        res.end(JSON.stringify(reposCache));
      } else {
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'Failed to fetch repos from GitHub' }));
      }
    }
    return;
  }

  // Static files
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Astrak Tools Dashboard running at http://localhost:${PORT}`);
  if (!GITHUB_TOKEN) {
    console.warn('WARNING: GITHUB_TOKEN not set - /api/repos will not work');
  }
});
