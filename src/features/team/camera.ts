import type { IScannerControls } from "@zxing/browser";
import type { Exception, Result } from "@zxing/library";

import type { CameraFailureReason } from "./scannerState";

export interface CameraController {
  stop(): void;
}

export interface QrCamera {
  start(
    video: HTMLVideoElement,
    onDetected: (payload: string) => void,
    onFailure: (reason: CameraFailureReason) => void,
  ): Promise<CameraController>;
}

type ReaderControls = Pick<IScannerControls, "stop">;
type ReaderResult = Pick<Result, "getText">;
type ReaderError = Pick<Exception, "getKind">;

interface QrReader {
  decodeFromStream(
    stream: MediaStream,
    video: HTMLVideoElement,
    onResult: (
      result: ReaderResult | undefined,
      error: ReaderError | undefined,
      controls: ReaderControls,
    ) => void,
  ): Promise<ReaderControls>;
}

interface CameraDependencies {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  loadReader: () => Promise<QrReader>;
}

export class CameraUnavailableError extends Error {
  constructor(readonly reason: CameraFailureReason) {
    super(reason);
    this.name = "CameraUnavailableError";
  }
}

export function createQrCameraAdapter(dependencies: CameraDependencies): QrCamera {
  return {
    async start(video, onDetected, onFailure) {
      if (!dependencies.getUserMedia) {
        throw new CameraUnavailableError("unsupported");
      }

      prepareVideo(video);
      let stream: MediaStream | null = null;
      let readerControls: ReaderControls | null = null;
      let stopped = false;
      const release = (controls: ReaderControls | null = readerControls) => {
        if (stopped) {
          return;
        }
        stopped = true;
        try {
          controls?.stop();
        } catch {
          // Media cleanup below must still complete if the decoder stop fails.
        }
        stopStream(stream);
        video.srcObject = null;
        video.removeAttribute("src");
      };

      try {
        stream = await dependencies.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" } },
        });
        const reader = await dependencies.loadReader();
        readerControls = await reader.decodeFromStream(stream, video, (result, error, controls) => {
          if (stopped) {
            return;
          }
          if (result) {
            onDetected(result.getText());
            return;
          }
          if (!error || isExpectedDecodeMiss(error)) {
            return;
          }
          release(controls);
          onFailure("failed");
        });
      } catch (error) {
        release();
        if (error instanceof CameraUnavailableError) {
          throw error;
        }
        throw new CameraUnavailableError(cameraFailureReason(error));
      }

      return {
        stop() {
          release();
        },
      };
    },
  };
}

export const qrCamera = createQrCameraAdapter({
  getUserMedia:
    typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia
      ? (constraints) => navigator.mediaDevices.getUserMedia(constraints)
      : undefined,
  loadReader: async () => {
    const { BrowserQRCodeReader } = await import("@zxing/browser");
    return new BrowserQRCodeReader();
  },
});

function prepareVideo(video: HTMLVideoElement): void {
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      // Continue releasing the remaining tracks.
    }
  }
}

const EXPECTED_DECODE_MISSES = new Set([
  "NotFoundException",
  "ChecksumException",
  "FormatException",
]);

function isExpectedDecodeMiss(error: ReaderError): boolean {
  try {
    return EXPECTED_DECODE_MISSES.has(error.getKind());
  } catch {
    return false;
  }
}

function cameraFailureReason(error: unknown): CameraFailureReason {
  if (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  ) {
    return "denied";
  }
  return "failed";
}
