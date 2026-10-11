// Детерминированные «фото» для превью: canvas-градиенты, без сети.
const PALETTES: [string, string, string][] = [
  ['#f6d365', '#fda085', '#5b5bd6'],
  ['#a1c4fd', '#c2e9fb', '#0e7c5b'],
  ['#fbc2eb', '#a6c1ee', '#a11e5c'],
  ['#84fab0', '#8fd3f4', '#1e6fb8'],
  ['#fccb90', '#d57eeb', '#b3541e'],
  ['#e0c3fc', '#8ec5fc', '#6d28d9'],
];

export function makeArt(seed: number, w = 600, h = 450): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d');
  if (!x) return '';
  const [a, b, accent] = PALETTES[seed % PALETTES.length] ?? PALETTES[0]!;
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  // «Солнце» и холмы — каждый сид даёт свою картинку.
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  x.fillStyle = accent;
  x.globalAlpha = 0.85;
  x.beginPath();
  x.arc(w * (0.25 + rnd(50) / 100), h * (0.25 + rnd(30) / 100), 40 + rnd(50), 0, Math.PI * 2);
  x.fill();
  x.globalAlpha = 0.35;
  x.fillStyle = '#ffffff';
  for (let i = 0; i < 3; i += 1) {
    x.beginPath();
    x.ellipse(rnd(w), h * 0.75 + rnd(Math.floor(h * 0.2)), 120 + rnd(120), 40 + rnd(40), 0, 0, Math.PI * 2);
    x.fill();
  }
  x.globalAlpha = 1;
  return c.toDataURL('image/jpeg', 0.85);
}
