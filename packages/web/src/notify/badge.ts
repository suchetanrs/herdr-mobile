/**
 * The tab title and favicon say how many agents want you: "(2) Herdr" and a
 * dot on the icon (blocked's red when one needs you, else done's blue).
 * On an installed PWA the app badge too, where the browser has one.
 */
export class AttentionBadge {
  private base: HTMLImageElement | null = null;
  private last = '';

  constructor(
    private readonly title = 'Herdr',
    private readonly iconUrl = '/app/favicon-32.png',
  ) {}

  update(counts: { blocked: number; done: number }, colors: { blocked: string; done: string }): void {
    const n = counts.blocked + counts.done;
    const key = `${counts.blocked}/${counts.done}`;
    if (key === this.last) return;
    this.last = key;
    document.title = n > 0 ? `(${n}) ${this.title}` : this.title;
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (n > 0) nav.setAppBadge?.(n).catch(() => {});
    else nav.clearAppBadge?.().catch(() => {});
    this.drawIcon(n > 0 ? (counts.blocked > 0 ? colors.blocked : colors.done) : null);
  }

  private drawIcon(dot: string | null): void {
    const link = document.getElementById('favicon') as HTMLLinkElement | null;
    if (!link) return;
    if (!dot) {
      link.href = this.iconUrl;
      return;
    }
    const paint = (img: HTMLImageElement) => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const g = c.getContext('2d');
      if (!g) return;
      g.drawImage(img, 0, 0, 64, 64);
      g.beginPath();
      g.arc(50, 14, 13, 0, Math.PI * 2);
      g.fillStyle = '#101114';
      g.fill();
      g.beginPath();
      g.arc(50, 14, 10, 0, Math.PI * 2);
      g.fillStyle = dot;
      g.fill();
      link.href = c.toDataURL('image/png');
    };
    if (this.base?.complete) paint(this.base);
    else {
      const img = new Image();
      img.onload = () => {
        this.base = img;
        paint(img);
      };
      img.src = this.iconUrl;
    }
  }
}
