import { describe, expect, it } from "vitest";
import audioOnly from "./__fixtures__/audio_only.json";
import horizontal from "./__fixtures__/horizontal_noaudio.json";
import rotated from "./__fixtures__/rotated.json";
import vertical from "./__fixtures__/vertical.json";
import vp9 from "./__fixtures__/vp9.json";
import {
  ProbeError,
  aspectLabel,
  checkUploadFile,
  evaluateCompatibility,
  formatBytes,
  formatDuration,
  parseFfprobe,
  thumbnailPathFor,
} from "./media";

const MB = 1024 * 1024;

describe("checkUploadFile", () => {
  it("aceita MP4/MOV/WebM pelo MIME ou pela extensão", () => {
    expect(checkUploadFile({ name: "a.mp4", size: MB, type: "video/mp4" })).toEqual({ ok: true, mime: "video/mp4" });
    expect(checkUploadFile({ name: "a.MOV", size: MB, type: "" })).toEqual({ ok: true, mime: "video/quicktime" });
    expect(checkUploadFile({ name: "a.webm", size: MB, type: "video/webm" })).toEqual({ ok: true, mime: "video/webm" });
  });
  it("recusa formato, vazio e acima do limite", () => {
    expect(checkUploadFile({ name: "a.avi", size: MB, type: "video/x-msvideo" }).ok).toBe(false);
    expect(checkUploadFile({ name: "a.mp4", size: 0, type: "video/mp4" }).ok).toBe(false);
    const big = checkUploadFile({ name: "a.mp4", size: 51 * MB, type: "video/mp4" });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.reason).toContain("50 MB");
    expect(checkUploadFile({ name: "a.mp4", size: 51 * MB, type: "video/mp4" }, 100 * MB).ok).toBe(true);
  });
});

describe("formatação", () => {
  it("bytes e duração", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1.5 * MB)).toBe("1,5 MB");
    expect(formatBytes(50 * MB)).toBe("50 MB");
    expect(formatDuration(5_000)).toBe("0:05");
    expect(formatDuration(65_400)).toBe("1:05");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatDuration(null)).toBe("—");
  });
  it("proporção", () => {
    expect(aspectLabel(1080, 1920)).toBe("9:16");
    expect(aspectLabel(1080, 1080)).toBe("1:1");
    expect(aspectLabel(1000, 1700)).toBe("1000×1700");
  });
  it("caminho da thumbnail", () => {
    expect(thumbnailPathFor("ws/id/original.mp4")).toBe("ws/id/thumb.jpg");
  });
});

describe("parseFfprobe (saídas reais do ffprobe)", () => {
  it("vertical H.264 + AAC", () => {
    const p = parseFfprobe(vertical);
    expect(p).toMatchObject({ width: 360, height: 640, videoCodec: "h264", audioCodec: "aac", hasAudio: true, fps: 30, rotation: 0 });
    expect(p.durationMs).toBeGreaterThanOrEqual(4900);
    expect(p.durationMs).toBeLessThanOrEqual(5100);
  });
  it("horizontal sem áudio", () => {
    expect(parseFfprobe(horizontal)).toMatchObject({ width: 640, height: 360, hasAudio: false, audioCodec: null, fps: 25 });
  });
  it("rotação de 90° troca as dimensões de exibição", () => {
    const p = parseFfprobe(rotated);
    expect(p.rotation % 180).toBe(90);
    expect(p).toMatchObject({ width: 360, height: 640 });
  });
  it("WebM VP9", () => {
    expect(parseFfprobe(vp9)).toMatchObject({ videoCodec: "vp9", audioCodec: "opus", container: "matroska,webm" });
  });
  it("arquivo sem vídeo e saída inválida", () => {
    expect(() => parseFfprobe(audioOnly)).toThrow(ProbeError);
    expect(() => parseFfprobe(null)).toThrow(ProbeError);
    expect(() => parseFfprobe({ streams: [{ codec_type: "video", width: 0, height: 0 }] })).toThrow("invalid_dimensions");
  });
});

describe("evaluateCompatibility", () => {
  it("vertical H.264/AAC de 5s é ok em todas", () => {
    const c = evaluateCompatibility(parseFfprobe(vertical), "mp4");
    expect(Object.values(c.platforms).map((p) => p.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(c.rulesVersion).toContain("preliminar");
  });
  it("WebM VP9 é erro no Instagram/Facebook e ok no TikTok/YouTube", () => {
    const c = evaluateCompatibility(parseFfprobe(vp9), "webm");
    expect(c.platforms.instagram_reels.status).toBe("error");
    expect(c.platforms.facebook_reels.status).toBe("error");
    expect(c.platforms.tiktok.status).toBe("ok");
    expect(c.platforms.youtube_shorts.status).toBe("ok");
  });
  it("horizontal e curto gera apenas avisos (limites preliminares)", () => {
    const c = evaluateCompatibility(parseFfprobe(horizontal), "mp4");
    expect(c.platforms.instagram_reels.status).toBe("warning");
    const codes = c.platforms.instagram_reels.issues.map((i) => i.code);
    expect(codes).toContain("not_vertical");
    expect(codes).toContain("too_short");
  });
  it("duração longa: aviso de Short no YouTube", () => {
    const p = { ...parseFfprobe(vertical), durationMs: 200_000 };
    const c = evaluateCompatibility(p, "mp4");
    expect(c.platforms.youtube_shorts.issues[0]?.code).toBe("too_long");
    expect(c.platforms.facebook_reels.issues.map((i) => i.code)).toContain("too_long");
    expect(c.platforms.instagram_reels.status).toBe("ok");
  });
});

import { normalizeHashtags } from "./media";
import { ilikePattern } from "./validators";

describe("normalizeHashtags", () => {
  it("normaliza, remove duplicados e símbolos", () => {
    expect(normalizeHashtags("#Reels, viral  #reels ##dica; café!")).toEqual(["#Reels", "#viral", "#dica", "#café"]);
    expect(normalizeHashtags("")).toEqual([]);
    expect(normalizeHashtags(Array.from({ length: 40 }, (_, i) => `t${i}`).join(" "))).toHaveLength(30);
  });
});

describe("ilikePattern", () => {
  it("escapa curingas", () => {
    expect(ilikePattern("50%_off")).toBe("%50\\%\\_off%");
  });
});
