const fs = require("node:fs");
const path = require("node:path");
const rate = 48000,
  duration = 32,
  N = rate * duration,
  tau = Math.PI * 2;
const music = new Float32Array(N * 2),
  fx = new Float32Array(N * 2);
let seed = 1729;
const noise = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
};
function put(buffer, start, length, gain, kind, hz = 440, pan = 0) {
  const at = Math.round(start * rate),
    samples = Math.round(length * rate);
  let low = 0;
  for (let i = 0; i < samples && at + i < N; i++) {
    if (at + i < 0) continue;
    const t = i / rate,
      p = i / samples,
      n = noise();
    low += 0.07 * (n - low);
    let v = 0;
    if (kind === "pad")
      v =
        (Math.sin(tau * hz * t) +
          0.24 * Math.sin(tau * hz * 1.003 * t) +
          0.13 * Math.sin(tau * hz * 2 * t)) *
        Math.min(1, t / 0.3) *
        Math.min(1, (length - t) / 0.8);
    if (kind === "pluck")
      v =
        (Math.sin(tau * hz * t) +
          0.2 * Math.sin(tau * hz * 2 * t) +
          0.07 * Math.sin(tau * hz * 3 * t)) *
        Math.exp(-t * 8) *
        (1 - Math.exp(-t * 300));
    if (kind === "bass")
      v =
        (Math.sin(tau * hz * t) + 0.16 * Math.sin(tau * hz * 2 * t)) *
        Math.min(1, t / 0.01) *
        Math.exp(-t * 3);
    if (kind === "kick")
      v =
        Math.sin(tau * (48 * t + 1.4 * (1 - Math.exp(-t * 28)))) *
        Math.exp(-t * 17);
    if (kind === "key")
      v = (n * 0.6 + Math.sin(tau * hz * t) * 0.4) * Math.exp(-t * 150);
    if (kind === "hat") v = (n - low) * Math.exp(-t * 100);
    if (kind === "snap")
      v = (low * 2 + Math.sin(tau * hz * t) * 0.25) * Math.exp(-t * 48);
    if (kind === "sweep")
      v =
        (low * 3 + Math.sin(tau * (100 * t + 600 * t * t)) * 0.06) *
        Math.sin(Math.PI * p) ** 2;
    if (kind === "impact")
      v =
        (Math.sin(tau * (39 * t + 0.6 * (1 - Math.exp(-t * 15)))) + 0.4 * low) *
        Math.exp(-t * 5);
    const j = (at + i) * 2;
    buffer[j] += v * gain * Math.sqrt((1 - pan) / 2);
    buffer[j + 1] += v * gain * Math.sqrt((1 + pan) / 2);
  }
}
const beat = 0.5,
  chords = [
    [146.83, 220, 293.66, 369.99],
    [130.81, 196, 261.63, 329.63],
    [110, 164.81, 220, 293.66],
    [123.47, 185, 246.94, 329.63],
  ];
for (let bar = 0; bar < 8; bar++) {
  const start = bar * 4,
    chord = chords[bar % 4];
  chord.forEach((hz, i) =>
    put(music, start, 4.8, 0.045, "pad", hz, (i - 1.5) * 0.32),
  );
  for (let j = 0; j < 16; j++) {
    const s = start + j * 0.25;
    if (s > 29) continue;
    const heroBreak = s >= 15.55 && s < 16.6;
    if (!heroBreak) {
      put(
        music,
        s,
        0.8,
        j % 2 ? 0.055 : 0.085,
        "pluck",
        chord[(j * 3) % 4] * (j % 3 ? 2 : 4),
        j % 2 ? 0.45 : -0.45,
      );
      if (j % 2 === 0) {
        put(music, s, 0.35, 0.3, "kick");
        put(music, s + 0.06, 0.42, 0.13, "bass", chord[0] / 2);
      }
      put(music, s + 0.125, 0.08, 0.028, "hat", 0, j % 2 ? 0.4 : -0.4);
      if (j % 4 === 2) put(music, s, 0.12, 0.1, "snap", 170);
    }
  }
}
// Every foreground event is tied to its visual frame, including each prompt character.
const prompt =
  "Design a USB-powered temperature and humidity monitor with Wi-Fi.";
for (let i = 1; i <= prompt.length; i++)
  put(
    fx,
    (190 + 25 + (118 * i) / prompt.length) / 60,
    0.055,
    0.14,
    "key",
    650 + (i % 7) * 90,
    i % 2 ? 0.15 : -0.15,
  );
put(fx, 370 / 60, 0.1, 0.3, "snap", 240);
[70, 77, 84, 91, 184, 430, 670, 940, 1300, 1570, 1701, 1798].forEach((f, i) => {
  put(fx, (f - 15) / 60, 0.45, 0.15, "sweep", 0, i % 2 ? 0.15 : -0.15);
  put(fx, f / 60, 0.8, i === 7 ? 0.32 : 0.22, "impact");
});
for (let i = 0; i < 4; i++) {
  put(fx, (458 + i * 9) / 60, 0.15, 0.16, "snap", 500 + i * 150);
  put(fx, (787 + i * 12) / 60, 0.13, 0.14, "snap", 320 + i * 90);
  put(fx, (966 + i * 12) / 60, 0.15, 0.18, "snap", 200 + i * 60);
}
for (let i = 0; i < 30; i++)
  put(
    fx,
    (1015 + i * 1.7) / 60,
    0.14,
    0.024,
    "pluck",
    1000 + i * 35,
    ((i % 3) - 1) * 0.4,
  );
for (let i = 0; i < 14; i++)
  put(fx, (1316 + i * 6) / 60, 0.08, 0.1, "key", 1000 + i * 30);
[293.66, 440, 587.33].forEach((hz, i) =>
  put(fx, 1798 / 60, 1.8, 0.13, "pluck", hz, (i - 1) * 0.3),
);
// Two quiet stereo echoes give the synth room without washing out the edits.
for (let i = N - 1; i >= 0; i--)
  for (let c = 0; c < 2; c++) {
    if (i > rate * 0.1875)
      music[i * 2 + c] += music[(i - 9000) * 2 + 1 - c] * 0.17;
    if (i > rate * 0.375) music[i * 2 + c] += music[(i - 18000) * 2 + c] * 0.08;
  }
function save(name, b) {
  const wav = Buffer.alloc(44 + N * 4);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(N * 4, 40);
  let peak = 0,
    sum = 0;
  for (let i = 0; i < N; i++) {
    const fade = Math.min(1, i / rate / 0.08, (duration - i / rate) / 1.1);
    for (let c = 0; c < 2; c++) {
      const v = Math.tanh(b[i * 2 + c] * 1.3) * fade;
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
      wav.writeInt16LE(Math.round(v * 32767), 44 + (i * 2 + c) * 2);
    }
  }
  fs.writeFileSync(path.join(__dirname, "../public/signal", name), wav);
  console.log(name, { duration, peak, rms: Math.sqrt(sum / (N * 2)) });
}
save("score.wav", music);
save("foley.wav", fx);
