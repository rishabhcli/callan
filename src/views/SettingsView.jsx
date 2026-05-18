import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

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

  // Pull the new business-ops dashboards. Each polled every 10s.
  const [experiments, setExperiments] = useState(null);
  const [economics, setEconomics] = useState(null);
  const [reputation, setReputation] = useState(null);
  const [referrals, setReferrals] = useState(null);

  useEffect(() => {
    let live = true;
    const fetchAll = async () => {
      try {
        const [exp, econ, rep, ref] = await Promise.all([
          api.experiments().catch(() => null),
          api.economicsByNiche().catch(() => null),
          api.reputationStatus().catch(() => null),
          api.referralsRollup().catch(() => null)
        ]);
        if (!live) return;
        setExperiments(exp);
        setEconomics(econ);
        setReputation(rep);
        setReferrals(ref);
      } catch {
        // ignore
      }
    };
    fetchAll();
    const id = setInterval(fetchAll, 10000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const mrr = health?.revenue?.mrrUsd ?? 0;
  const margin24h = health?.revenue?.marginUsd24h ?? 0;
  const cost24h = health?.revenue?.costsUsd24h ?? 0;

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
        <Card title="revenue" wide>
          <div className="nyna-stat-row">
            <Stat k="MRR" v={`$${mrr.toFixed(2)}`} tone="good" />
            <Stat k="24h margin" v={`$${Number(margin24h).toFixed(2)}`} tone={margin24h >= 0 ? 'good' : 'bad'} />
            <Stat k="24h cost"   v={`$${Number(cost24h).toFixed(2)}`} />
            <Stat k="referrals"  v={referrals?.totalClicks ?? 0} />
            <Stat k="alerts"     v={reputation?.recentAlerts?.length ?? 0} tone={reputation?.recentAlerts?.length ? 'bad' : 'good'} />
          </div>
        </Card>

        {experiments && Object.keys(experiments.rollups || {}).length ? (
          <Card title="A/B experiments" wide>
            {Object.entries(experiments.rollups).map(([key, rows]) => (
              <ExperimentTable key={key} experimentKey={key} rows={rows} />
            ))}
          </Card>
        ) : null}

        {economics?.niches?.length ? (
          <Card title="per-niche P&L (lifetime)" wide>
            <NicheTable niches={economics.niches} totals={economics.totals} />
          </Card>
        ) : null}

        {referrals?.topReferrers?.length ? (
          <Card title="referral footprint">
            <div style={{ fontSize: 12, color: 'var(--ink-300)', marginBottom: 10 }}>
              {referrals.totalClicks || 0} total clicks from shipped sites' "Built by callmemaybe" footer.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {referrals.topReferrers.slice(0, 8).map((r) => (
                <div key={r.source_lead_id || 'unknown'} className="nyna-setting-row" style={{ paddingBottom: 8, paddingTop: 8 }}>
                  <div>
                    <div className="nyna-setting-label">{r.business_name || r.source_lead_id || 'unknown'}</div>
                    {r.niche ? <div className="nyna-setting-hint">{r.niche}</div> : null}
                  </div>
                  <div className="nyna-setting-value">{r.clicks} clicks</div>
                </div>
              ))}
            </div>
          </Card>
        ) : null}

        {reputation ? (
          <Card title="reputation throttle">
            <Row
              label="Opt-out rate (24h)"
              hint={reputation.optOutRate?.alert ? 'ALERT: above 5% threshold' : 'Below the 5% red threshold.'}
              value={`${((reputation.optOutRate?.rate || 0) * 100).toFixed(1)}%`}
            />
            <Row
              label="Voicemail-only rate (last 25)"
              hint={reputation.voicemailRate?.alert ? 'ALERT: above 80% threshold' : 'Below the 80% red threshold.'}
              value={`${((reputation.voicemailRate?.rate || 0) * 100).toFixed(1)}%`}
            />
            <Row
              label="Top area code (24h)"
              value={`${reputation.topAreaCodes?.[0]?.areaCode || '—'} · ${reputation.topAreaCodes?.[0]?.attempts24h || 0} calls`}
            />
          </Card>
        ) : null}
        <Card title="autonomy">
          <Row
            label="Autonomous outreach"
            hint={running ? 'Workers will pick the next callable lead automatically.' : 'Calls/builds only run when you click them.'}
            value={running ? 'on' : 'paused'}
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
          <Row label="Queued"       value={quotas.queued ?? 0} />
          <Row label="In-call"      value={quotas.calling ?? 0} />
          <Row label="Blocked"      value={quotas.blocked ?? 0} />
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
               value="callmemaybe.dev/share/build/:token" />
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

function Stat({ k, v, tone = 'muted' }) {
  return (
    <div className="nyna-stat-cell">
      <div className="nyna-detail-stat-key">{k}</div>
      <div className={`nyna-detail-stat-val ${tone === 'good' ? 'is-good' : tone === 'bad' ? 'is-warm' : ''}`}>{v}</div>
    </div>
  );
}

function ExperimentTable({ experimentKey, rows }) {
  if (!rows?.length) return null;
  const best = rows.reduce((acc, r) => (r.revenuePerAssignment > (acc?.revenuePerAssignment || -Infinity) ? r : acc), null);
  return (
    <div className="nyna-experiment-block">
      <div className="nyna-experiment-key">{experimentKey}</div>
      <table className="nyna-mini-table">
        <thead>
          <tr>
            <th>arm</th>
            <th>assignments</th>
            <th>conversions</th>
            <th>rate</th>
            <th>$/assign</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.arm} className={best && r.arm === best.arm ? 'is-winner' : ''}>
              <td>{r.arm}</td>
              <td>{r.assignments}</td>
              <td>{r.conversions}</td>
              <td>{(r.conversionRate * 100).toFixed(1)}%</td>
              <td>${(r.revenuePerAssignment / 100).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NicheTable({ niches, totals }) {
  return (
    <table className="nyna-mini-table">
      <thead>
        <tr>
          <th>niche</th>
          <th>leads</th>
          <th>cost</th>
          <th>revenue</th>
          <th>margin</th>
          <th>%</th>
        </tr>
      </thead>
      <tbody>
        {niches.slice(0, 12).map((n) => (
          <tr key={n.niche} className={n.marginUsd > 0 ? 'is-positive' : n.marginUsd < 0 ? 'is-negative' : ''}>
            <td>{n.niche}</td>
            <td>{n.leads}</td>
            <td>${Number(n.costUsd || 0).toFixed(2)}</td>
            <td>${Number(n.revenueUsd || 0).toFixed(2)}</td>
            <td>${Number(n.marginUsd || 0).toFixed(2)}</td>
            <td>{((n.marginPct || 0) * 100).toFixed(0)}%</td>
          </tr>
        ))}
        {totals ? (
          <tr style={{ fontWeight: 600, borderTop: '1px solid var(--line-strong)' }}>
            <td>TOTAL</td>
            <td>{totals.leads}</td>
            <td>${Number(totals.costUsd || 0).toFixed(2)}</td>
            <td>${Number(totals.revenueUsd || 0).toFixed(2)}</td>
            <td>${Number(totals.marginUsd || 0).toFixed(2)}</td>
            <td>{((totals.marginPct || 0) * 100).toFixed(0)}%</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}
