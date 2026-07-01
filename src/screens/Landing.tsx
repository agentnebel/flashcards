import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import './Landing.css';

const GITHUB_URL = 'https://github.com/agentnebel/flashcards';

const FEATURES: { color: string; title: string; desc: string }[] = [
  {
    color: 'var(--landing-good)',
    title: 'Wiederholung nach Plan (FSRS)',
    desc: 'Was du sicher kannst, kommt seltener dran. FSRS plant jede Karte einzeln nach deinem Gedächtnis. Die Wiederholungen, die du eh nicht brauchst, fallen weg.',
  },
  {
    color: 'var(--landing-tint)',
    title: 'Sync über alle Geräte',
    desc: 'Einmal anmelden und deine Karten sind auf jedem Gerät dabei. Der Fortschritt gleicht sich im Hintergrund ab, du musst nichts weiter tun.',
  },
  {
    color: 'var(--landing-hard)',
    title: 'Bilder und drei Kartentypen',
    desc: 'Normal, umgekehrt oder Lückentext. Bilder ziehst du einfach ins Feld, die App rechnet sie automatisch klein.',
  },
  {
    color: 'var(--landing-again)',
    title: 'Import und Backup',
    desc: 'Deine alten Decks bringst du aus CSV, TSV oder Anki mit. Und wenn du gehen willst, nimmst du alles als JSON wieder mit, Bilder inklusive.',
  },
  {
    color: 'var(--landing-good)',
    title: 'Offline und werbefrei',
    desc: 'Einmal installiert, läuft die App auch ohne Internet. Kein Tracking, keine Werbung.',
  },
];

const GRADES = [
  { label: 'Nochmal', ivl: '<1 Min', cls: 'landing-grade--again' },
  { label: 'Schwer', ivl: '8 Min', cls: 'landing-grade--hard' },
  { label: 'Gut', ivl: '4 Tage', cls: 'landing-grade--good' },
  { label: 'Einfach', ivl: '9 Tage', cls: 'landing-grade--easy' },
];

export function Logo({ small }: { small?: boolean }) {
  return (
    <span className={`landing-logo${small ? ' landing-logo--sm' : ''}`}>
      <span className="landing-logo-mark">
        <span className="landing-logo-dot" />
      </span>
      Flashcards
    </span>
  );
}

// Gemeinsamer Kopf/Fuß für Landing- und Rechtstext-Seiten — eine Quelle, damit beide
// Seiten wie dieselbe Website wirken und Footer-Links nicht auseinanderlaufen.
export function SiteHeader() {
  return (
    <header className="landing-header">
      <Link to="/" aria-label="Zur Startseite">
        <Logo />
      </Link>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="landing-footer">
      <Link to="/" aria-label="Zur Startseite">
        <Logo small />
      </Link>
      <div className="landing-footer-links">
        <Link to="/datenschutz">Datenschutz</Link>
        <Link to="/impressum">Impressum</Link>
        <a href={`${GITHUB_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">MIT-Lizenz</a>
      </div>
    </footer>
  );
}

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.74.5 12.02c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.79 2.73 1.27 3.4.97.11-.76.41-1.27.74-1.56-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.42.36.8 1.08.8 2.18 0 1.58-.01 2.85-.01 3.24 0 .31.21.68.8.56A10.53 10.53 0 0 0 23.5 12.02C23.5 5.74 18.27.5 12 .5Z" />
    </svg>
  );
}

function FlipCard() {
  const [flipped, setFlipped] = useState(false);
  return (
    <div className="landing-flip-wrap" data-parallax="0.05">
      <div className="landing-flip-perspective">
        <div
          className={`landing-flip-inner${flipped ? ' is-flipped' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Beispielkarte umdrehen"
          onClick={() => setFlipped((f) => !f)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setFlipped((f) => !f);
            }
          }}
        >
          <div className="landing-flip-face landing-flip-front">
            <div className="landing-flip-q">Was ist die beste Art, etwas nicht zu vergessen?</div>
            <div className="landing-flip-hint">Zum Umdrehen antippen</div>
          </div>
          <div className="landing-flip-face landing-flip-back">
            <div className="landing-flip-a">
              Es im <em>richtigen Moment</em> wiederholen.
            </div>
            <div className="landing-flip-sub">
              Genau das macht Flashcards für dich, Karte für Karte.
            </div>
          </div>
        </div>
      </div>
      <div className="landing-flip-caption">
        So läuft eine Wiederholung: Karte ansehen, umdrehen, ehrlich bewerten.
      </div>
    </div>
  );
}

// Dezente Scroll-Reveal- + Parallax-Effekte. Bewusst performant:
//  · Reveal via IntersectionObserver (einmalig, dann unobserve) — kein Scroll-Listener.
//  · Parallax über EINE passive, rAF-gedrosselte Scroll-Schleife, die nur `transform`
//    schreibt (Compositor-only, kein Layout/Reflow). Anker werden einmal vermessen.
//  · Vollständig deaktiviert bei `prefers-reduced-motion` und auf schmalen Screens.
function useScrollEffects(rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // --- Scroll-Reveal ---
    let io: IntersectionObserver | null = null;
    if (!reduce) {
      io = new IntersectionObserver(
        (entries, obs) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add('is-visible');
              obs.unobserve(e.target); // einmalig: kein Re-Hide beim Zurückscrollen
            }
          }
        },
        { rootMargin: '0px 0px -10% 0px', threshold: 0.12 },
      );
      root.querySelectorAll('.reveal').forEach((el) => io!.observe(el));
    }
    // (bei reduced-motion macht das CSS `.reveal` ohnehin sofort sichtbar)

    // --- Parallax ---
    const pNodes = Array.from(root.querySelectorAll<HTMLElement>('[data-parallax]'));
    let onScroll: (() => void) | null = null;
    let onResize: (() => void) | null = null;

    if (!reduce && pNodes.length) {
      let anchors: number[] = [];
      let ticking = false;

      const measure = () => {
        for (const el of pNodes) el.style.transform = '';
        anchors = pNodes.map((el) => {
          const r = el.getBoundingClientRect();
          return r.top + window.scrollY + r.height / 2; // Dokument-Mitte des Elements
        });
      };
      const update = () => {
        ticking = false;
        const small = window.innerWidth < 700; // Parallax auf Mobile aus (weniger sinnvoll)
        const mid = window.scrollY + window.innerHeight / 2;
        pNodes.forEach((el, i) => {
          if (small) {
            el.style.transform = '';
            return;
          }
          const speed = parseFloat(el.dataset.parallax || '0');
          const y = (mid - anchors[i]) * speed;
          el.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`;
        });
      };
      onScroll = () => {
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(update);
        }
      };
      onResize = () => {
        measure();
        update();
      };

      for (const el of pNodes) el.style.willChange = 'transform';
      measure();
      update();
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onResize);
    }

    return () => {
      io?.disconnect();
      if (onScroll) window.removeEventListener('scroll', onScroll);
      if (onResize) window.removeEventListener('resize', onResize);
      for (const el of pNodes) {
        el.style.willChange = '';
        el.style.transform = '';
      }
    };
  }, [rootRef]);
}

export default function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
  useScrollEffects(rootRef);

  return (
    <div className="landing" ref={rootRef}>
      <SiteHeader />

      <section className="landing-hero">
        <div>
          <div className="landing-eyebrow">KOSTENLOS UND OPEN SOURCE</div>
          <h1 className="landing-h1">
            Zwei Seiten.
            <br />
            Ein Ziel:
            <br />
            Es bleibt&nbsp;drin.
          </h1>
          <p className="landing-lead">
            Lernkarten für dein Handy und deinen Browser. Die App zeigt dir jede Karte genau dann
            wieder, wenn du sie fast vergessen hättest. So bleibst du dran, ohne Abo und ohne Werbung.
          </p>
          <div className="landing-cta-row">
            <Link to="/app" className="landing-btn landing-btn-primary">App öffnen</Link>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="landing-btn landing-btn-secondary">
              <GithubMark />
              GitHub
            </a>
          </div>
        </div>
        <FlipCard />
      </section>

      <section className="landing-shots-section reveal">
        <div className="landing-section-head">
          <div className="landing-eyebrow">HANDY UND BROWSER</div>
          <h2 className="landing-h2">Auf jedem Gerät zuhause.</h2>
        </div>
        <div className="landing-shots">
          <figure className="shot-browser">
            <div className="shot-browser-bar" aria-hidden="true">
              <span />
              <span />
              <span />
              <div className="shot-browser-url">flashcards.belz.cloud</div>
            </div>
            <img
              src="/screenshots/app-desktop.png"
              width={1600}
              height={1058}
              loading="lazy"
              alt="Flashcards im Browser: die Kartenübersicht mit den eigenen Decks"
            />
          </figure>
          <figure className="shot-phone">
            <img
              src="/screenshots/app-mobile.png"
              width={640}
              height={1369}
              loading="lazy"
              alt="Flashcards auf dem Handy: eine aufgedeckte Karte mit den Bewertungstasten"
            />
          </figure>
        </div>
      </section>

      <section className="landing-features">
        <div className="landing-section-head reveal">
          <div className="landing-eyebrow">FUNKTIONEN</div>
          <h2 className="landing-h2">Fünf Dinge, die zählen.</h2>
        </div>
        <div className="landing-feature-list">
          {FEATURES.map((f, i) => (
            <div className="landing-feature-row reveal" key={f.title}>
              <div className="landing-feature-index" style={{ color: f.color }}>
                {String(i + 1).padStart(2, '0')}
              </div>
              <div>
                <div className="landing-feature-heading">{f.title}</div>
                <div className="landing-feature-desc">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-algo">
        <div className="landing-algo-grid">
          <div className="reveal">
            <div className="landing-eyebrow" style={{ color: 'var(--landing-good)', marginBottom: 16 }}>
              DER ALGORITHMUS
            </div>
            <h2 className="landing-h2">Warum du seltener wiederholen musst.</h2>
            <p>
              Nach jeder Karte sagst du selbst, wie es lief: <strong>Nochmal</strong>,{' '}
              <strong>Schwer</strong>, <strong>Gut</strong> oder <strong>Einfach</strong>. Daraus
              rechnet FSRS aus, wann du die Karte das nächste Mal brauchst.
            </p>
            <p>
              Was sitzt, rutscht Tage oder Wochen nach hinten. Der Rest kommt öfter dran. So landet
              deine Lernzeit da, wo sie wirklich etwas bringt.
            </p>
          </div>
          <div className="landing-mock" data-parallax="0.04">
            <div className="landing-mock-q">Hauptstadt von Japan?</div>
            <div className="landing-grade-grid">
              {GRADES.map((g) => (
                <div className={`landing-grade ${g.cls}`} key={g.label}>
                  <div className="landing-grade-label">{g.label}</div>
                  <div className="landing-grade-ivl">{g.ivl}</div>
                </div>
              ))}
            </div>
            <div className="landing-mock-caption">
              <span>Auf dem Handy wischst du, am Desktop drückst du 1 bis 4.</span>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-oss reveal">
        <div className="landing-eyebrow">100% OPEN SOURCE</div>
        <h2 className="landing-h2">Der Code gehört dir. MIT-lizenziert.</h2>
        <p className="landing-oss-lead">
          Der komplette Code liegt offen auf GitHub. Schau rein, fork ihn oder hoste die App selbst.
          Im Free-Tier von Cloudflare kostet dich das praktisch nichts.
        </p>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="landing-btn landing-btn-invert">
          <GithubMark />
          Auf GitHub ansehen
        </a>
      </section>

      <SiteFooter />
    </div>
  );
}
