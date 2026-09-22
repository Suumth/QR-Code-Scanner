import { expect, test, vi } from "vitest";

import {
  CameraUnavailableError,
  createQrCameraAdapter,
} from "../../src/features/team/camera";

test("camera adapter requests the environment camera, prepares iOS inline video, emits QR text, and stops cleanly", async () => {
  const stopTrack = vi.fn();
  const stopReader = vi.fn();
  const stream = fakeStream(stopTrack);
  const getUserMedia = vi.fn(async () => stream);
  const reader = {
    decodeFromStream: vi.fn(async (_stream, _video, onResult) => {
      onResult({ getText: () => "https://example.com/v/aaaaaaaaaaaaaaaaaaaaaa" });
      return { stop: stopReader };
    }),
  };
  const loadReader = vi.fn(async () => reader);
  const detected: string[] = [];
  const video = document.createElement("video");
  const camera = createQrCameraAdapter({ getUserMedia, loadReader });

  const controller = await camera.start(video, (value) => detected.push(value), vi.fn());

  expect(getUserMedia).toHaveBeenCalledWith({
    audio: false,
    video: { facingMode: { ideal: "environment" } },
  });
  expect(video.playsInline).toBe(true);
  expect(video.muted).toBe(true);
  expect(video.autoplay).toBe(true);
  expect(detected).toEqual(["https://example.com/v/aaaaaaaaaaaaaaaaaaaaaa"]);

  controller.stop();
  controller.stop();
  expect(stopReader).toHaveBeenCalledTimes(1);
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(video.srcObject).toBeNull();
});

test("unsupported and permission-denied cameras fail with truthful reasons", async () => {
  const unsupported = createQrCameraAdapter({
    getUserMedia: undefined,
    loadReader: vi.fn(),
  });
  await expect(
    unsupported.start(document.createElement("video"), vi.fn(), vi.fn()),
  ).rejects.toEqual(new CameraUnavailableError("unsupported"));

  const deniedError = new DOMException("permission denied", "NotAllowedError");
  const denied = createQrCameraAdapter({
    getUserMedia: vi.fn(async () => Promise.reject(deniedError)),
    loadReader: vi.fn(),
  });
  await expect(denied.start(document.createElement("video"), vi.fn(), vi.fn())).rejects.toEqual(
    new CameraUnavailableError("denied"),
  );
});

test("a decoder startup failure releases every acquired camera track", async () => {
  const stopTrack = vi.fn();
  const stream = fakeStream(stopTrack);
  const camera = createQrCameraAdapter({
    getUserMedia: vi.fn(async () => stream),
    loadReader: vi.fn(async () => ({
      decodeFromStream: vi.fn(async () => Promise.reject(new Error("decoder failed"))),
    })),
  });

  await expect(camera.start(document.createElement("video"), vi.fn(), vi.fn())).rejects.toEqual(
    new CameraUnavailableError("failed"),
  );
  expect(stopTrack).toHaveBeenCalledTimes(1);
});

test("expected ZXing decode misses stay silent and the camera keeps detecting", async () => {
  const stopTrack = vi.fn();
  const stopReader = vi.fn();
  const stream = fakeStream(stopTrack);
  let callback: DecodeCallback | undefined;
  const camera = createQrCameraAdapter({
    getUserMedia: vi.fn(async () => stream),
    loadReader: vi.fn(async () => ({
      decodeFromStream: vi.fn(async (_stream, _video, onResult) => {
        callback = onResult as DecodeCallback;
        return { stop: stopReader };
      }),
    })),
  });
  const detected = vi.fn();
  const failed = vi.fn();

  await startWithFailureCallback(camera, document.createElement("video"), detected, failed);
  for (const kind of ["NotFoundException", "ChecksumException", "FormatException"]) {
    callback?.(undefined, decodeError(kind), { stop: stopReader });
  }
  callback?.({ getText: () => "https://example.com/v/aaaaaaaaaaaaaaaaaaaaaa" }, undefined, {
    stop: stopReader,
  });

  expect(failed).not.toHaveBeenCalled();
  expect(stopReader).not.toHaveBeenCalled();
  expect(stopTrack).not.toHaveBeenCalled();
  expect(detected).toHaveBeenCalledWith(
    "https://example.com/v/aaaaaaaaaaaaaaaaaaaaaa",
  );
});

test("a fatal asynchronous ZXing callback stops once, clears media, and notifies once", async () => {
  const stopTrack = vi.fn();
  const stopReader = vi.fn();
  const stream = fakeStream(stopTrack);
  let callback: DecodeCallback | undefined;
  const video = document.createElement("video");
  video.srcObject = stream;
  const camera = createQrCameraAdapter({
    getUserMedia: vi.fn(async () => stream),
    loadReader: vi.fn(async () => ({
      decodeFromStream: vi.fn(async (_stream, _video, onResult) => {
        callback = onResult as DecodeCallback;
        return { stop: stopReader };
      }),
    })),
  });
  const failed = vi.fn();

  const controller = await startWithFailureCallback(camera, video, vi.fn(), failed);
  callback?.(undefined, decodeError("IllegalStateException"), { stop: stopReader });
  callback?.(undefined, decodeError("IllegalStateException"), { stop: stopReader });

  expect(stopReader).toHaveBeenCalledTimes(1);
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(video.srcObject).toBeNull();
  expect(failed).toHaveBeenCalledTimes(1);
  expect(failed).toHaveBeenCalledWith("failed");

  controller.stop();
  expect(stopReader).toHaveBeenCalledTimes(1);
  expect(stopTrack).toHaveBeenCalledTimes(1);
});

function fakeStream(stop: () => void): MediaStream {
  return {
    getTracks: () => [{ stop } as MediaStreamTrack],
  } as MediaStream;
}

interface DecodeFailure {
  getKind(): string;
}

type DecodeCallback = (
  result?: { getText(): string },
  error?: DecodeFailure,
  controls?: { stop(): void },
) => void;

function decodeError(kind: string): DecodeFailure {
  return { getKind: () => kind };
}

function startWithFailureCallback(
  camera: ReturnType<typeof createQrCameraAdapter>,
  video: HTMLVideoElement,
  onDetected: (payload: string) => void,
  onFailure: (reason: "failed") => void,
): Promise<{ stop(): void }> {
  return (
    camera.start as unknown as (
      video: HTMLVideoElement,
      onDetected: (payload: string) => void,
      onFailure: (reason: "failed") => void,
    ) => Promise<{ stop(): void }>
  )(video, onDetected, onFailure);
}
