import { CHANGELOG, APP_VERSION } from '@aperio/shared';
import { Modal, Pill } from './ui';
import { fmtDate } from '../lib/format';
import { useT } from '../i18n';

const TONE: Record<string, string> = { neu: 'green', verbessert: 'blue', behoben: 'amber' };

/** "Was ist neu?" – öffnet sich per Klick auf die Versionsnummer */
export function ChangelogDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Modal title={`${t('Was ist neu?')} · Version ${APP_VERSION}`} onClose={onClose} size="lg">
      <div className="stack">
        {CHANGELOG.map((e) => (
          <div key={e.version} className="card flat">
            <div className="row" style={{ marginBottom: 8 }}>
              <h3>Version {e.version}</h3><span className="muted">{e.title}</span><span className="right small muted">{fmtDate(e.date)}</span>
            </div>
            {e.changes.map((c, i) => (
              <div key={i} className="row" style={{ alignItems: 'flex-start', marginBottom: 4 }}>
                <Pill tone={TONE[c.type]}>{c.type}</Pill><span>{c.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}
