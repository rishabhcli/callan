import React, { useState } from 'react';
import { api } from '../api.js';

export default function DiscoverForm() {
  const [niche, setNiche] = useState('barbershops');
  const [city, setCity] = useState('San Francisco');
  const [count, setCount] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api.discover({ niche: niche.trim(), city: city.trim(), count: Number(count) });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="discover" onSubmit={submit}>
      <div className="discover-row">
        <label className="field">
          <span className="field-key">niche</span>
          <input
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="barbershops"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span className="field-key">city</span>
          <input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="San Francisco"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="field field-narrow">
          <span className="field-key">count</span>
          <input
            type="number"
            min={1}
            max={8}
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'dispatching…' : 'discover'}
        </button>
      </div>
      {err ? <div className="field-error">{err}</div> : null}
    </form>
  );
}
