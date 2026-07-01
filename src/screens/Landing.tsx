import { useState } from 'react';
import { Link } from 'react-router-dom';
import './Landing.css';

const GITHUB_URL = 'https://github.com/agentnebel/flashcards';

const FEATURES: { color: string; title: string; desc: string }[] = [
  {
    color: 'var(--landing-good)',
    title: 'Intelligente Wiederholung (FSRS)',
    desc: 'Was du kannst, siehst du seltener. Der Algorithmus plant jede Karte einzeln nach deinem Gedächtnis — und spart dir echte Lernzeit.',
  },
  {
    color: 'var(--landing-tint)',
    title: 'Sync über alle Geräte',
    desc: 'Einmal anmelden, fertig. Karten und Fortschritt landen automatisch überall — beim Start, beim Online-Gehen und alle 60 Sekunden.',
  },
  {
    color: 'var(--landing-hard)',
    title: 'Bilder & drei Kartentypen',
    desc: 'Einfach, umgekehrt oder Lückentext — mit Bildern per Einfügen, Datei oder Drag & Drop, automatisch komprimiert.',
  },
  {
    color: 'var(--landing-again)',
    title: 'Import & Backup',
    desc: 'CSV, TSV und ältere .apkg-Dateien kommen mit Feld-Mapping rein — und als JSON inklusive Bilder wieder raus.',
  },
  {
    color: 'var(--landing-good)',
    title: 'Offline & werbefrei',
    desc: 'Installierbare PWA — lernen geht immer. Kein Tracking, kein Abo, keine Werbung.',
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

function FlipCard() {
  const [flipped, setFlipped] = useState(false);
  return (
    <div className="landing-flip-wrap">
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
            <div className="landing-flip-hint">Karte zum Umdrehen bewegen ↻</div>
          </div>
          <div className="landing-flip-face landing-flip-back">
            <div className="landing-flip-a">
              Sie im <em>richtigen Moment</em> wiederholen.
            </div>
            <div className="landing-flip-sub">
              Genau das übernimmt Flashcards für dich — automatisch, für jede einzelne Karte.
            </div>
          </div>
        </div>
      </div>
      <div className="landing-flip-caption">
        Genau so funktioniert der Lernmodus: antippen → Antwort → bewerten.
      </div>
    </div>
  );
}

export default function Landing() {
  return (
    <div className="landing">
      <SiteHeader />

      <section className="landing-hero">
        <div>
          <div className="landing-eyebrow">DEINE KARTEN · ÜBERALL · FÜR IMMER</div>
          <h1 className="landing-h1">
            Zwei Seiten.
            <br />
            Ein Ziel:
            <br />
            Es bleibt&nbsp;drin.
          </h1>
          <p className="landing-lead">
            Lernkarten fürs Handy und den Browser. Der clevere Wiederholungs-Rhythmus sorgt dafür,
            dass du dranbleibst — ganz ohne Werbung oder Abo.
          </p>
          <div className="landing-cta-row">
            <Link to="/app" className="landing-btn landing-btn-primary">Demo</Link>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="landing-btn landing-btn-secondary">
              ★ GitHub
            </a>
          </div>
        </div>
        <FlipCard />
      </section>

      <section className="landing-features">
        <div className="landing-section-head">
          <div className="landing-eyebrow">FUNKTIONEN</div>
          <h2 className="landing-h2">Fünf Dinge, die zählen.</h2>
        </div>
        <div className="landing-feature-list">
          {FEATURES.map((f, i) => (
            <div className="landing-feature-row" key={f.title}>
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
          <div>
            <div className="landing-eyebrow" style={{ color: 'var(--landing-good)', marginBottom: 16 }}>
              DER ALGORITHMUS
            </div>
            <h2 className="landing-h2">Warum du seltener wiederholen musst.</h2>
            <p>
              Nach jeder Karte bewertest du selbst: <strong>Nochmal, Schwer, Gut</strong> oder{' '}
              <strong>Einfach</strong>. FSRS berechnet daraus, wann genau du diese Karte das nächste
              Mal siehst.
            </p>
            <p>
              Gut Gekonntes wandert Tage oder Wochen nach hinten. So verbringst du deine Zeit mit dem,
              was noch wackelt — nicht mit dem, was längst sitzt.
            </p>
          </div>
          <div className="landing-mock">
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
              <span>Auf dem Handy: swipen · am Desktop: Tasten 1–4</span>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-oss">
        <div className="landing-eyebrow">100% OPEN SOURCE</div>
        <h2 className="landing-h2">Der Code gehört dir. MIT-lizenziert.</h2>
        <p className="landing-oss-lead">
          Alles liegt offen auf GitHub. Lies mit, fork es, hoste es selbst — läuft im Free-Tier von
          Cloudflare praktisch kostenlos.
        </p>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="landing-btn landing-btn-invert">
          ★&nbsp;&nbsp;Star auf GitHub
        </a>
      </section>

      <SiteFooter />
    </div>
  );
}
