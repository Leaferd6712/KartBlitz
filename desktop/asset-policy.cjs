const path = require('node:path');
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.glb':'model/gltf-binary','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.py':'text/plain; charset=utf-8','.ps1':'text/plain; charset=utf-8' };
function resolveAsset(url, root, allowed) {
  const request = new URL(url);
  if(request.protocol !== 'kbapp:' || request.hostname !== 'game' || request.username || request.password || request.port) throw new Error('Unknown application origin');
  const pathname = decodeURIComponent(request.pathname);
  if(pathname.includes('\\') || pathname.includes('\0')) throw new Error('Invalid asset path');
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//,'');
  if(!allowed.has(relative)) throw new Error('Asset is not in the runtime manifest');
  const file = path.resolve(root,relative);
  const within = path.relative(root,file);
  if(!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('Asset escapes the runtime');
  return { file, type:MIME[path.extname(file)] || 'application/octet-stream' };
}
module.exports = { resolveAsset };
