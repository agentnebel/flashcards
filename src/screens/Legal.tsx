import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { SiteFooter, SiteHeader } from './Landing';
import './Landing.css';
import './Legal.css';

const GITHUB_URL = 'https://github.com/agentnebel/flashcards';

// Akzentfarben der nummerierten Abschnitte — greift denselben Farbzyklus wie die
// Feature-Liste der Landingpage auf, damit die Rechtstexte als Teil derselben Seite wirken.
const ACCENTS = ['var(--landing-tint)', 'var(--landing-good)', 'var(--landing-hard)', 'var(--landing-again)'];

interface Section {
  title: string;
  body: ReactNode;
}

function LegalLayout({
  eyebrow,
  title,
  updated,
  identityLabel,
  identity,
  sections,
  note,
}: {
  eyebrow: string;
  title: string;
  updated: string;
  identityLabel: string;
  identity: ReactNode;
  sections: Section[];
  note?: ReactNode;
}) {
  // Beim Öffnen einer Rechtstext-Seite (z. B. aus dem Footer heraus) nach oben scrollen,
  // sonst erbt die neue Route die Scrollposition der vorher gescrollten Landingpage.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="landing">
      <SiteHeader />

      <main className="legal">
        <Link to="/" className="legal-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Zur Startseite
        </Link>

        <div className="legal-hero">
          <div className="landing-eyebrow">{eyebrow}</div>
          <h1 className="legal-title">{title}</h1>
          <span className="legal-meta">Stand: {updated}</span>
        </div>

        <div className="legal-identity">
          <div className="legal-identity-label">{identityLabel}</div>
          <div className="legal-identity-body">{identity}</div>
        </div>

        <div className="legal-sheet">
          {sections.map((s, i) => (
            <section className="legal-section" key={s.title}>
              <div className="legal-section-index" style={{ color: ACCENTS[i % ACCENTS.length] }}>
                {String(i + 1).padStart(2, '0')}
              </div>
              <div className="legal-section-main">
                <h2 className="legal-section-title">{s.title}</h2>
                <div className="legal-section-body">{s.body}</div>
              </div>
            </section>
          ))}
        </div>

        {note && <p className="legal-note">{note}</p>}
      </main>

      <SiteFooter />
    </div>
  );
}

export function Impressum() {
  return (
    <LegalLayout
      eyebrow="RECHTLICHES"
      title="Impressum"
      updated="Juli 2026"
      identityLabel="ANGABEN GEMÄSS § 5 DDG"
      identity={
        <>
          <strong>Sven Belz</strong>
          <br />
          Kolpingstr. 5
          <br />
          65604 Elz, Deutschland
          <div className="legal-identity-contact">
            <span>
              Telefon: <a href="tel:+4915124045201">+49&nbsp;(0)&nbsp;1512&nbsp;404&nbsp;520&nbsp;1</a>
            </span>
            <span>
              E-Mail: <a href="mailto:hello@svenbelz.com">hello@svenbelz.com</a>
            </span>
          </div>
        </>
      }
      sections={[
        {
          title: 'Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV',
          body: <p>Sven Belz, Anschrift wie oben.</p>,
        },
        {
          title: 'Projektstatus',
          body: (
            <p>
              Flashcards ist ein privates, nicht-kommerzielles Open-Source-Projekt. Der Quellcode ist auf{' '}
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a> unter der MIT-Lizenz
              veröffentlicht.
            </p>
          ),
        },
        {
          title: 'EU-Streitschlichtung',
          body: (
            <p>
              Die Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung (OS) bereit:{' '}
              <a href="https://ec.europa.eu/consumers/odr/" target="_blank" rel="noopener noreferrer">
                ec.europa.eu/consumers/odr
              </a>
              . Da es sich um ein privates, nicht-kommerzielles Projekt handelt, besteht keine Verpflichtung
              und keine Bereitschaft zur Teilnahme an einem Streitbeilegungsverfahren vor einer
              Verbraucherschlichtungsstelle.
            </p>
          ),
        },
        {
          title: 'Haftung für Inhalte',
          body: (
            <p>
              Als Diensteanbieter bin ich gemäß § 7 Abs. 1 DDG für eigene Inhalte auf diesen Seiten nach den
              allgemeinen Gesetzen verantwortlich. Nach §§ 8 bis 10 DDG bin ich als Diensteanbieter jedoch
              nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu überwachen oder nach
              Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen.
            </p>
          ),
        },
        {
          title: 'Haftung für Links',
          body: (
            <p>
              Dieses Angebot enthält Links zu externen Webseiten Dritter (z. B. GitHub, Cloudflare), auf
              deren Inhalte ich keinen Einfluss habe. Für diese fremden Inhalte kann ich keine Gewähr
              übernehmen. Für die Inhalte der verlinkten Seiten ist stets der jeweilige Anbieter
              verantwortlich.
            </p>
          ),
        },
        {
          title: 'Urheberrecht',
          body: (
            <p>
              Der Quellcode dieses Projekts steht unter der MIT-Lizenz und darf gemäß deren Bedingungen
              verwendet werden. Texte und Layout dieser Seite unterliegen im Übrigen dem deutschen
              Urheberrecht, soweit nicht anders gekennzeichnet.
            </p>
          ),
        },
      ]}
    />
  );
}

export function Datenschutz() {
  return (
    <LegalLayout
      eyebrow="RECHTLICHES"
      title="Datenschutzerklärung"
      updated="Juli 2026"
      identityLabel="VERANTWORTLICHER"
      identity={
        <>
          <strong>Sven Belz</strong>
          <br />
          Kolpingstr. 5, 65604 Elz, Deutschland
          <div className="legal-identity-contact">
            <span>
              E-Mail: <a href="mailto:hello@svenbelz.com">hello@svenbelz.com</a>
            </span>
          </div>
        </>
      }
      sections={[
        {
          title: 'Nutzung ohne Konto (lokaler Modus)',
          body: (
            <p>
              Flashcards funktioniert ohne Registrierung vollständig offline: Decks, Karten, Bilder und dein
              Lernfortschritt werden ausschließlich lokal in deinem Browser gespeichert (IndexedDB). Dabei
              werden <strong>keine</strong> personenbezogenen Daten an einen Server übertragen.
            </p>
          ),
        },
        {
          title: 'Registrierung & Sync (optional)',
          body: (
            <>
              <p>Wenn du dich für den geräteübergreifenden Sync registrierst, verarbeiten wir:</p>
              <ul>
                <li>deine E-Mail-Adresse (zur Anmeldung),</li>
                <li>dein Passwort — ausschließlich als Hash (PBKDF2-SHA256), niemals im Klartext,</li>
                <li>
                  deine Lerninhalte (Decks, Karten, Notizen, Bewertungsverlauf) sowie von dir hochgeladene
                  Bilder, damit sie zwischen deinen Geräten synchronisiert werden können.
                </li>
              </ul>
              <p>
                Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO (Erfüllung eines Vertrags bzw. vorvertragliche
                Maßnahmen auf deinen Wunsch, den Sync-Dienst bereitzustellen).
              </p>
            </>
          ),
        },
        {
          title: 'Keine Cookies, kein Tracking',
          body: (
            <p>
              Die Anmeldung erfolgt über ein Zugriffs-Token (JWT), das lokal in deinem Browser gespeichert
              wird — nicht als Cookie. Diese Seite setzt keine Tracking- oder Analyse-Cookies, keine
              Werbe-Tracker und keine Analytics-Dienste Dritter ein. Ein Cookie-Consent-Banner ist daher
              nicht erforderlich.
            </p>
          ),
        },
        {
          title: 'Hosting & Auftragsverarbeitung',
          body: (
            <p>
              Diese Anwendung wird über Cloudflare betrieben (Cloudflare Workers, D1-Datenbank,
              R2-Objektspeicher). Die Datenverarbeitung erfolgt in der EU-Region von Cloudflare. Mit
              Cloudflare als Auftragsverarbeiter besteht ein Auftragsverarbeitungsvertrag gemäß Art. 28 DSGVO.
              Beim Aufruf jeder Webseite verarbeitet Cloudflare als Hosting-Anbieter technisch bedingt
              kurzzeitig Zugriffsdaten (u. a. IP-Adresse, Zeitstempel, aufgerufene URL) in Server-Logfiles, um
              den Betrieb und die Sicherheit der Infrastruktur zu gewährleisten (Art. 6 Abs. 1 lit. f DSGVO,
              berechtigtes Interesse an Betriebssicherheit).
            </p>
          ),
        },
        {
          title: 'Speicherdauer & Löschung',
          body: (
            <p>
              Lokale Daten bleiben, bis du sie in deinem Browser selbst löschst (z. B. über „Abmelden" in den
              Einstellungen, das lokale Daten auf diesem Gerät entfernt). Serverseitig gespeicherte Kontodaten
              bleiben bestehen, bis du die Löschung deines Kontos beantragst — schreib uns dazu einfach eine
              E-Mail an <a href="mailto:hello@svenbelz.com">hello@svenbelz.com</a>; eine
              Selbstbedienungsfunktion zur Kontolöschung gibt es aktuell noch nicht in der App.
            </p>
          ),
        },
        {
          title: 'Deine Rechte',
          body: (
            <p>
              Du hast das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung,
              Datenübertragbarkeit sowie Widerspruch gegen die Verarbeitung deiner personenbezogenen Daten
              (Art. 15–21 DSGVO). Wende dich dafür an die oben genannte Kontakt-E-Mail. Außerdem steht dir ein
              Beschwerderecht bei einer Datenschutz-Aufsichtsbehörde zu.
            </p>
          ),
        },
        {
          title: 'Datensicherheit',
          body: (
            <p>
              Die Übertragung erfolgt verschlüsselt (TLS). Passwörter werden ausschließlich als Hash
              gespeichert (PBKDF2-SHA256 mit zufälligem Salt), nie im Klartext.
            </p>
          ),
        },
        {
          title: 'Änderungen dieser Erklärung',
          body: (
            <p>
              Diese Datenschutzerklärung kann angepasst werden, wenn sich der Funktionsumfang von Flashcards
              oder die rechtlichen Anforderungen ändern. Es gilt jeweils die auf dieser Seite veröffentlichte
              Fassung.
            </p>
          ),
        },
      ]}
      note="Diese Angaben wurden nach bestem Wissen für den tatsächlichen Funktionsumfang von Flashcards erstellt und ersetzen keine Rechtsberatung."
    />
  );
}
