import { rootProps } from "./base/root-props.js";
import { useMemo, useState } from "react";
import { MonitorPlay, Play } from "lucide-react";
import { cn } from "@cn/lib/utils";
import { useDesigner } from "@context/designer-context";

/**
 * video_embed — remote video player for the page builder.
 *
 * Detects the platform from a plain video URL and renders the proper embed:
 *  - YouTube (watch / youtu.be / shorts / live)  -> youtube-nocookie iframe
 *  - Facebook (videos, reels, watch) -> facebook plugins/video.php iframe
 *  - Vimeo -> player.vimeo.com iframe
 *  - TikTok -> tiktok embed v2 iframe
 *  - Dailymotion -> dailymotion embed iframe
 *  - Direct files (.mp4/.webm/.ogv/.mov/.m4v) -> native <video>
 *  - Anything else -> raw URL in an iframe (fallback)
 *
 * SSR-safe: no window access at module scope; the click-to-load facade is
 * deterministic (computed from data only), so hydration matches.
 */

const FILE_RE = /\.(mp4|webm|ogv|ogg|mov|m4v)(\?.*)?$/i;

const truthy = (v) => [true, "true", 1, "1"].includes(v);

function parseVideo(url) {
  if (!url) return null;
  const u = String(url).trim();
  if (!u) return null;

  if (FILE_RE.test(u)) return { type: "file", src: u };

  let m = u.match(
    /(?:youtube\.com\/(?:watch\?[^#]*?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{6,})/
  );
  if (m) {
    const id = m[1];
    return {
      type: "youtube",
      vertical: /youtube\.com\/shorts\//.test(u),
      thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      embed: (p) => `https://www.youtube-nocookie.com/embed/${id}?${p}`,
    };
  }

  m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) {
    const id = m[1];
    return { type: "vimeo", embed: (p) => `https://player.vimeo.com/video/${id}?${p}` };
  }

  m = u.match(/tiktok\.com\/@[\w.\-]+\/video\/(\d+)/);
  if (m) {
    const id = m[1];
    return { type: "tiktok", vertical: true, embed: () => `https://www.tiktok.com/embed/v2/${id}` };
  }

  m = u.match(/dailymotion\.com\/video\/(\w+)/);
  if (m) {
    const id = m[1];
    return { type: "dailymotion", embed: (p) => `https://www.dailymotion.com/embed/video/${id}?${p}` };
  }

  if (/facebook\.com|fb\.watch/.test(u)) {
    return {
      type: "facebook",
      vertical: /\/reel\//.test(u),
      embed: (p) =>
        `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(u)}&show_text=false&${p}`,
    };
  }

  return { type: "iframe", embed: () => u };
}

function buildParams(type, { autoplay, muted, loop, hideControls }) {
  const p = new URLSearchParams();
  switch (type) {
    case "youtube":
      if (autoplay) { p.set("autoplay", "1"); p.set("mute", "1"); }
      else if (muted) p.set("mute", "1");
      if (hideControls) p.set("controls", "0");
      if (loop) p.set("loop", "1");
      p.set("rel", "0");
      p.set("playsinline", "1");
      break;
    case "vimeo":
      if (autoplay) { p.set("autoplay", "1"); p.set("muted", "1"); }
      else if (muted) p.set("muted", "1");
      if (hideControls) p.set("controls", "0");
      if (loop) p.set("loop", "1");
      p.set("dnt", "1");
      break;
    case "facebook":
      if (autoplay) { p.set("autoplay", "true"); p.set("mute", "true"); }
      break;
    case "dailymotion":
      if (autoplay) { p.set("autoplay", "1"); p.set("mute", "1"); }
      break;
    default:
      break;
  }
  return p.toString();
}

function firstImageSrc(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) return parsed[0]?.src || null;
    return parsed?.src || null;
  } catch (e) {
    return typeof value === "string" && value.length ? value : null;
  }
}

function aspectPadding(data, video) {
  const ratio = data.aspect_ratio || (video?.vertical ? "9:16" : "16:9");
  const [w = 16, h = 9] = String(ratio).split(":").map(Number);
  return (h / w) * 100;
}

export default function VideoEmbed(props) {
  const data = props.data || {};
  const { designerMode } = useDesigner();

  const video = useMemo(() => parseVideo(data.video_url), [data.video_url]);

  const autoplay = truthy(data.autoplay);
  const clickToLoad = data.click_to_load == null ? true : truthy(data.click_to_load);
  const [active, setActive] = useState(autoplay && !clickToLoad);

  const poster = firstImageSrc(data.poster) || video?.thumb || null;
  const padding = aspectPadding(data, video);
  const title = data.title || "Video";

  const frame = (children) => (
    <div
      {...rootProps(props)}
      className={cn("relative w-full overflow-hidden rounded-xl bg-black", props.className)}
      style={{ paddingTop: `${padding}%` }}
    >
      <div className="absolute inset-0">{children}</div>
    </div>
  );

  if (!video) {
    return frame(
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <MonitorPlay className="h-10 w-10 opacity-60" />
        <span className="text-sm opacity-80">
          {designerMode ? "Set the video URL in the settings panel" : "Video not available"}
        </span>
      </div>
    );
  }

  if (video.type === "file") {
    return frame(
      <video
        className="h-full w-full object-contain"
        src={video.src}
        poster={poster || undefined}
        controls={!truthy(data.hide_controls)}
        autoPlay={autoplay && !designerMode}
        muted={autoplay || truthy(data.muted)}
        loop={truthy(data.loop)}
        playsInline
        title={title}
      />
    );
  }

  const showFacade = designerMode || (!active && clickToLoad && !autoplay);

  if (showFacade) {
    return frame(
      <button
        type="button"
        aria-label={`Play: ${title}`}
        onClick={() => !designerMode && setActive(true)}
        className="group h-full w-full cursor-pointer border-0 bg-transparent p-0"
      >
        {poster ? (
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url("${poster}")` }}
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-zinc-800 to-zinc-950" />
        )}
        <div className="absolute inset-0 bg-black/30 transition-colors group-hover:bg-black/20" />
        <span className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm transition-transform group-hover:scale-110">
          <Play className="ml-1 h-8 w-8 fill-white text-white" />
        </span>
        {designerMode && (
          <span className="absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs uppercase tracking-wide text-white/80">
            {video.type}
          </span>
        )}
      </button>
    );
  }

  const params = buildParams(video.type, {
    // when the user clicked the facade, start playing right away
    autoplay: autoplay || (clickToLoad && active),
    muted: truthy(data.muted),
    loop: truthy(data.loop),
    hideControls: truthy(data.hide_controls),
  });

  return frame(
    <iframe
      className="h-full w-full border-0"
      src={video.embed(params)}
      title={title}
      loading="lazy"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}

VideoEmbed.metaFields = () => {
  return [[
    {
      group: "custom",
      elements: {
        video_url: {
          element: INPUT,
          data: {
            label: "Video URL",
            description:
              "Paste the regular video URL: YouTube (watch/shorts), Facebook (video or reel, must be public), Vimeo, TikTok, Dailymotion or a direct .mp4 file. The platform is detected automatically.",
          },
        },
        aspect_ratio: {
          element: SELECT,
          data: {
            label: "Aspect Ratio",
            description: "16:9 for regular video, 9:16 for vertical shorts/reels.",
            options: [
              { option: "16:9", value: "16:9" },
              { option: "9:16", value: "9:16" },
              { option: "4:3", value: "4:3" },
              { option: "1:1", value: "1:1" },
              { option: "21:9", value: "21:9" },
            ],
            default: "16:9",
          },
        },
        poster: {
          element: IMAGE_INPUT,
          data: {
            label: "Poster",
            description:
              "Cover image shown before playback. For YouTube the official thumbnail is used if none is set.",
            accept: "image/*",
          },
        },
        click_to_load: {
          element: SWITCH,
          data: {
            label: "Click to load",
            description:
              "Shows the cover with a play button and loads the player only on click (better performance). On by default.",
            default_value: 1,
          },
        },
        autoplay: {
          element: SWITCH,
          data: {
            label: "Autoplay",
            description: "Plays automatically (always muted, as required by browsers).",
          },
        },
        muted: { element: SWITCH, data: { label: "Muted" } },
        loop: { element: SWITCH, data: { label: "Loop" } },
        hide_controls: { element: SWITCH, data: { label: "Hide Controls" } },
      },
    },
  ]];
};
