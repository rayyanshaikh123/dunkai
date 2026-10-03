// Original 48 kHz stereo score and synchronized Foley for the 33.5 s cut.
const fs = require("node:fs"),
  path = require("node:path");
const rate = 48000,
  duration = 33.5,
  N = Math.round(rate * duration),
  music = new Float32Array(N * 2),
  fx = new Float32Array(N * 2),
  tau = 2 * Math.PI;
let seed = 143;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 4294967296) * 2 - 1;
};
function sound(b, start, length, hz, gain, kind = "bell", pan = 0) {
  const at = Math.round(start * rate),
    samples = Math.round(length * rate);
  for (let i = 0; i < samples && at + i < N; i++) {
    const t = i / rate,
      p = i / samples;
    let v = 0,
      env = 0;
    if (kind === "pad") {
      env = Math.min(t / 0.4, 1) * Math.min((length - t) / 1, 1);
      v = Math.sin(tau * hz * t) + 0.18 * Math.sin(tau * hz * 2.001 * t);
    } else if (kind === "key") {
      env = Math.exp(-t * 95);
      v = random() * 0.65 + Math.sin(tau * hz * t) * 0.35;
    } else if (kind === "air") {
      env = Math.sin(Math.PI * p) ** 2;
      v = random() * 0.3;
    } else if (kind === "kick") {
      env = Math.exp(-t * 17);
      v = Math.sin(tau * (48 + 80 * Math.exp(-t * 35)) * t);
    } else if (kind === "tick") {
      env = Math.exp(-t * 80);
      v = random();
    } else {
      env = Math.exp(-t * 6);
      v =
        Math.sin(tau * hz * t) +
        0.18 * Math.sin(tau * hz * 2.01 * t) +
        0.06 * Math.sin(tau * hz * 3 * t);
    }
    const j = (at + i) * 2;
    b[j] += v * env * gain * Math.sqrt((1 - pan) / 2);
    b[j + 1] += v * env * gain * Math.sqrt((1 + pan) / 2);
  }
}
const beat = 60 / 112,
  chords = [
    [146.83, 220, 293.66, 369.99],
    [130.81, 196, 261.63, 329.63],
    [110, 164.81, 220, 293.66],
    [123.47, 185, 246.94, 329.63],
  ];
for (let bar = 0; bar * beat * 8 < duration; bar++) {
  const start = bar * beat * 8,
    chord = chords[bar % 4];
  chord.forEach((h, i) =>
    sound(music, start, beat * 8 + 1, h, 0.025, "pad", (i - 1.5) * 0.35),
  );
  for (let j = 0; j < 8; j++) {
    const s = start + j * beat;
    sound(music, s, 1.2, chord[j % 4] * 2, 0.043, "bell", j % 2 ? 0.35 : -0.35);
    if (s > 2 && s < 32) {
      sound(music, s, 0.18, 70, 0.044, "kick");
      sound(
        music,
        s + beat * 0.5,
        0.04,
        0,
        0.009,
        "tick",
        j % 2 ? 0.45 : -0.45,
      );
    }
  }
}
const prompt =
  "Build an indoor environment monitor. Sense temperature, humidity and air quality. Report over Wi-Fi. Power it with USB.";
for (let i = 1; i <= prompt.length; i++)
  sound(
    fx,
    4.5 + (22 + (i * 86) / prompt.length) / 30,
    0.06,
    700 + (i % 7) * 90,
    0.075,
    "key",
    i % 2 ? 0.1 : -0.1,
  );
sound(fx, 4.5 + 125 / 30, 0.12, 260, 0.14, "key");
for (const s of [4.5, 9.5, 13.5, 19, 24, 28.5]) {
  sound(fx, s - 0.12, 0.42, 0, 0.055, "air");
  sound(fx, s + 0.17, 0.7, 880, 0.055, "bell");
}
for (let i = 0; i < 4; i++) {
  sound(fx, 9.5 + (10 + i * 15) / 30, 0.45, 587.33 + i * 73.4, 0.06);
  sound(fx, 13.5 + i * 0.6, 0.08, 1100, 0.075, "key");
  sound(fx, 19 + (8 + i * 11) / 30, 0.12, 350, 0.06, "key");
  sound(fx, 13.5 + 80 / 30 + i * 0.12, 0.09, 700 + i * 80, 0.055, "key");
}
for (let i = 0; i < 24; i++)
  sound(
    fx,
    19 + (22 + i * 2.4) / 30,
    0.15,
    950 + i * 23,
    0.014,
    "bell",
    i % 2 ? 0.3 : -0.3,
  );
function easing(x) {
  let lo = 0,
    hi = 1,
    u = 0.5;
  for (let j = 0; j < 22; j++) {
    u = (lo + hi) / 2;
    const v = 3 * (1 - u) ** 2 * u * 0.24 + 3 * (1 - u) * u * u * 0.36 + u ** 3;
    if (v < x) lo = u;
    else hi = u;
  }
  return 3 * (1 - u) ** 2 * u + 3 * (1 - u) * u * u + u ** 3;
}
for (let line = 1; line <= 15; line++) {
  let f = 10;
  while (f < 90 && easing((f - 10) / 80) < line / 15) f += 0.2;
  sound(fx, 24 + f / 30, 0.05, 1250, 0.045, "key");
}
sound(fx, 24 + 110 / 30, 0.5, 1174.66, 0.055);
sound(fx, 31, 1.7, 293.66, 0.12);
sound(fx, 31, 1.7, 587.33, 0.06);
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
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const fade = Math.min(i / rate / 0.8, 1, (duration - i / rate) / 1.2);
    for (let c = 0; c < 2; c++) {
      const v = Math.tanh(b[i * 2 + c]) * fade;
      peak = Math.max(peak, Math.abs(v));
      wav.writeInt16LE(Math.round(v * 32767), 44 + (i * 2 + c) * 2);
    }
  }
  fs.writeFileSync(path.join(__dirname, "../public", name), wav);
  console.log(
    name,
    "48 kHz stereo, duration",
    duration,
    "peak",
    peak.toFixed(3),
  );
}
save("score.wav", music);
save("sound-design.wav", fx);
