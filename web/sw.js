// Service worker: guarda só a "casca" do app (HTML, CSS, JS, ícones) para abrir
// sem internet. Respostas da API NUNCA são guardadas aqui (dados fiscais e pessoais).
const VERSAO = 'notavez-v5';
const CASCA = [
  '/', '/index.html', '/manifest.webmanifest', '/css/app.css',
  '/js/app.js', '/js/api.js', '/js/ui.js', '/js/store.js', '/js/rascunho.js',
  '/js/views/entrar.js', '/js/views/inicio.js', '/js/views/clientes.js', '/js/views/servicos.js', '/js/views/nota.js',
  '/js/views/revisao.js', '/js/views/resultado.js', '/js/views/historico.js', '/js/views/perfil.js', '/js/views/instalar.js',
  '/icons/icone.svg', '/icons/logo.svg', '/icons/logo-escuro.svg', '/icons/favicon-32.png',
  '/icons/icone-192.png', '/icons/icone-512.png', '/icons/icone-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  // Rede primeiro (pega atualizações); sem rede, usa a cópia guardada.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copia = r.clone(); caches.open(VERSAO).then((c) => c.put(e.request, copia)); }
    return r;
  }).catch(async () => (await caches.match(e.request)) || (e.request.mode === 'navigate' ? caches.match('/index.html') : Response.error())));
});
