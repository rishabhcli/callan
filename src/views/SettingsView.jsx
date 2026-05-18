import React from 'react';

const PROVIDER_LIST = [
  { key: 'gemini',       name: 'Google DeepMind / Gemini', purpose: 'reasoning + analyst plans' },
  { key: 'supermemory',  name: 'Supermemory',              purpose: 'long-term memory store' },
  { key: 'moss',         name: 'Moss',                     purpose: 'call index + semantic search' },
  { key: 'agentphone',   name: 'AgentPhone',               purpose: 'outbound voice agents' },
  { key: 'browserUse',   name: 'Browser Use',              purpose: 'cloud browser fleet' },
  { key: 'lovable',      name: 'Lovable',                  purpose: 'final site builder' },
  { key: 'agentmail',    name: 'AgentMail',                purpose: 'mail threads + replies' },
  { key: 'stripe',       name: 'Stripe',                   purpose: 'invoices + payments' }
];

export default function SettingsView({ health, outreach, onStartAutonomy, onStopAutonomy, onEmergencyStop }) {
  const providers = health?.providers || {};
  const mode = (health?.mode || 'init').toUpperCase();
  const running = !!outreach?.running;
  const quotas = outreach?.readiness?.outreach || health?.readiness?.outreach || {};
  const agents = outreach?.agents || {};
  const queue = outreach?.queue || {};

  return (
    <div className="nyna-settings-shell">
      <header className="nyna-settings-head">
        <div>
          <div className="nyna-detail-subtitle">configuration</div>
          <div className="nyna-detail-title">settings</div>
        </div>
        <div className="nyna-settings-mode">
          <div className="nyna-detail-stat-key">mode</div>
          <div className={`nyna-detail-stat-val is-${mode === 'MOCK' ? 'warm' : 'good'}`}>{mode}</div>
        </div>
      </header>

      <div className="nyna-settings">
        <Card title="autonomy">
          <Row
            label="Autonomous outreach"
            hint={running ? 'Workers will pick the next callable lead automatically.' : 'Calls/builds only run when you click them.'}
            value={running ? 'on' : 'paused'}
          />
          <Row
            label="Caller agents"
            hint="Concurrent workers draining queued outreach."
            value={`${agents.active ?? 0}/${agents.concurrency ?? 1}`}
          />
          <Row
            label="Queue slots"
            hint="Available caller capacity right now."
            value={agents.available ?? 0}
          />
          <div style={{ display: 'flex', gap: 8, paddingTop: 12 }}>
            {running ? (
              <button className="nyna-action nyna-action-primary" onClick={onStopAutonomy}>pause autonomy</button>
            ) : (
              <button className="nyna-action nyna-action-primary" onClick={onStartAutonomy}>resume autonomy</button>
            )}
            <button className="nyna-action nyna-action-danger" onClick={onEmergencyStop}>emergency stop</button>
          </div>
        </Card>

        <Card title="quotas (today)">
          <Row label="Calls placed" value={quotas.todaysCalls ?? 0} />
          <Row label="Opt-outs"     value={quotas.optOuts ?? 0} />
          <Row label="Queued"       value={queue.queued ?? quotas.queued ?? 0} />
          <Row label="In-call"      value={queue.running ?? quotas.calling ?? 0} />
          <Row label="Blocked"      value={queue.blockedVisible ?? quotas.blocked ?? 0} />
        </Card>

        <Card title="providers" wide>
          {PROVIDER_LIST.map((p) => (
            <div key={p.key} className="nyna-setting-row">
              <div>
                <div className="nyna-setting-label">{p.name}</div>
                <div className="nyna-setting-hint">{p.purpose}</div>
              </div>
              <div className="nyna-setting-value">
                {providers[p.key] ? <span style={{ color: 'var(--rose)' }}>● configured</span> : <span style={{ color: 'var(--ink-400)' }}>○ not configured</span>}
              </div>
            </div>
          ))}
        </Card>

        <Card title="customer-share defaults">
          <Row label="Allow per-build share link"
               hint="Customers receive a personal link to watch their build live."
               value="enabled" />
          <Row label="Auto-revoke when site ships"
               hint="Link stops resolving after the final URL is delivered."
               value="enabled" />
          <Row label="Share-link domain"
               hint="Public URL prefix sent in emails."
               value="callan.dev/share/build/:token" />
        </Card>

        <Card title="branding">
          <Row label="Palette"
               hint="Pearl Beige · Golden Apricot · Cotton Candy · Brown Red · Black Cherry"
               value="NYNÄ warm" />
          <Row label="Typeface (display)" value="Fraunces" />
          <Row label="Typeface (body)"   value="Inter" />
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children, wide }) {
  return (
    <section className="nyna-card" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <div className="nyna-card-title">{title}</div>
      <div className="nyna-card-body">{children}</div>
    </section>
  );
}

function Row({ label, hint, value }) {
  return (
    <div className="nyna-setting-row">
      <div>
        <div className="nyna-setting-label">{label}</div>
        {hint ? <div className="nyna-setting-hint">{hint}</div> : null}
      </div>
      <div className="nyna-setting-value">{value}</div>
    </div>
  );
}
