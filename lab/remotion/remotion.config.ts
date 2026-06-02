import { Config } from "@remotion/cli/config";

/**
 * Studio/CLI config. The server motion service uses the SSR APIs directly
 * (bundle + renderMedia) and sets codec/pixel-format/concurrency from
 * server config, so this file only governs `remotion studio` / `remotion still`
 * used for local preview and craft verification.
 */
Config.setVideoImageFormat("png"); // alpha-capable frames for transparent renders
Config.setConcurrency(2);
