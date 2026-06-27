export function journalSince(value = "30m") {
  const s = String(value).trim();
  const m = /^(\d+)\s*([smhd])?$/.exec(s);
  if (!m)
    return s;
  const n = Number(m[1]);
  const unit = m[2] || "m";
  const word = {
    s: "seconds",
    m: "minutes",
    h: "hours",
    d: "days",
  }[unit];
  return `${n} ${word} ago`;
}
