import { useEffect, useState } from "react";
import { ALL_JOB_IDS, JOBS } from "../game/jobs/jobs";
import {
  MAX_LEVEL,
  levelFromXp,
  xpForLevel,
  xpInCurrentLevel,
  xpToNextLevel,
} from "../game/jobs/xpTable";
import { selectJobXp, useGameStore } from "../game/store/gameStore";
import "./Jobs.css";

export function Jobs() {
  const xp = useGameStore(selectJobXp);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "j") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  return (
    <div className="jobs-panel" role="region" aria-label="Jobs">
      <div className="jobs-header">
        <span>Jobs</span>
        <button className="jobs-close" onClick={() => setOpen(false)} aria-label="Close jobs">
          ×
        </button>
      </div>
      <div className="jobs-list">
        {ALL_JOB_IDS.map((id) => (
          <JobRow key={id} jobId={id} totalXp={xp[id] ?? 0} />
        ))}
      </div>
      <div className="jobs-footer">J: toggle</div>
    </div>
  );
}

function JobRow({ jobId, totalXp }: { jobId: keyof typeof JOBS; totalXp: number }) {
  const def = JOBS[jobId];
  const level = levelFromXp(totalXp);
  const atMax = level >= MAX_LEVEL;
  const intoLevel = atMax ? 0 : xpInCurrentLevel(totalXp, level);
  const needed = atMax ? 0 : xpToNextLevel(level);
  const pct = atMax ? 100 : needed === 0 ? 0 : Math.min(100, (intoLevel / needed) * 100);

  return (
    <div className="jobs-row" title={def.description}>
      <div className="jobs-row-top">
        <span className="jobs-icon" style={{ color: def.color }}>{def.icon}</span>
        <span className="jobs-name">{def.name}</span>
        <span className="jobs-level">Lv {level}</span>
      </div>
      <div className="jobs-bar">
        <div
          className="jobs-bar-fill"
          style={{ width: `${pct}%`, background: def.color }}
        />
      </div>
      <div className="jobs-xp">
        {atMax ? (
          <span>MAX — {fmt(totalXp)} XP</span>
        ) : (
          <span>
            {fmt(intoLevel)} / {fmt(needed)} XP
            <span className="jobs-xp-total"> · {fmt(totalXp - xpForLevel(level))} into lv</span>
          </span>
        )}
      </div>
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.floor(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.floor(n));
}
