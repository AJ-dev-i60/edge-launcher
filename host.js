'use strict';

// Host resource metrics read straight from /proc.
//
// Coolify's v1 API exposes no metrics endpoint — Sentinel collects them but
// keeps them to itself, and the sentinel_token the API returns is Laravel
// encrypted, so it cannot be used from outside. Docker does not virtualise
// /proc, so a container on the Coolify host sees the HOST's CPU, memory and
// uptime. These are therefore whole-VPS figures, not this container's.
//
// Nothing here needs a privileged mount or the Docker socket.

const fs = require('fs/promises');

let previousCpu = null;
let current = null;

function parseMeminfo(text) {
  const mem = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s+kB/.exec(line);
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }
  return mem;
}

async function sample() {
  try {
    const [stat, meminfo, uptime, loadavg] = await Promise.all([
      fs.readFile('/proc/stat', 'utf8'),
      fs.readFile('/proc/meminfo', 'utf8'),
      fs.readFile('/proc/uptime', 'utf8'),
      fs.readFile('/proc/loadavg', 'utf8'),
    ]);

    // The aggregate "cpu" line is cumulative jiffies since boot, so a
    // percentage only exists relative to the previous sample. The first call
    // therefore reports null rather than a fabricated number.
    const fields = stat.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = (fields[3] || 0) + (fields[4] || 0); // idle + iowait
    const total = fields.reduce((a, b) => a + b, 0);

    let cpuPct = null;
    if (previousCpu) {
      const dTotal = total - previousCpu.total;
      const dIdle = idle - previousCpu.idle;
      if (dTotal > 0) cpuPct = Math.max(0, Math.min(100, Math.round(100 * (1 - dIdle / dTotal))));
    }
    previousCpu = { total, idle };

    const mem = parseMeminfo(meminfo);
    const memTotal = mem.MemTotal || 0;
    // MemAvailable accounts for reclaimable cache; MemFree alone would
    // overstate usage badly on any box that has been up a while.
    const memAvailable = mem.MemAvailable != null ? mem.MemAvailable : (mem.MemFree || 0);

    current = {
      cpuPct,
      cores: (stat.match(/^cpu\d+ /gm) || []).length || 1,
      memUsed: Math.max(0, memTotal - memAvailable),
      memTotal,
      swapUsed: Math.max(0, (mem.SwapTotal || 0) - (mem.SwapFree || 0)),
      swapTotal: mem.SwapTotal || 0,
      load1: parseFloat(loadavg.split(/\s+/)[0]) || 0,
      uptimeSec: Math.round(parseFloat(uptime.split(/\s+/)[0]) || 0),
      at: new Date().toISOString(),
    };
  } catch {
    // Not Linux, or /proc unreadable. The page hides the strip entirely
    // rather than showing zeroes that look like a healthy idle box.
    current = null;
  }
  return current;
}

const get = () => current;

module.exports = { sample, get };
