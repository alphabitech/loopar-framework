import { useState, useRef, useEffect} from 'react';
import { FileBrowser } from "./file-browser";
import FilePreview from "./file-preview";
import FileContainer from "./file-container";
import fileManager from "./file-manager";
import { MonitorUpIcon, DatabaseIcon, Globe2Icon, UploadCloudIcon, Trash2Icon, Loader2Icon } from "lucide-react";
import loopar from "loopar";
import { validateFile } from "@@file/defaults";
import { isEqual } from 'es-toolkit/predicate';
import { useDesigner } from "@context/designer-context";
import { __ } from "@global/i18n";

const origins = [
  { name: "Local", icon: MonitorUpIcon, color: "bg-secondary" },
  { name: "Server", icon: DatabaseIcon, color: "bg-warning" },
  { name: "Web", icon: Globe2Icon, color: "bg-primary" },
  { name: "Trash", icon: Trash2Icon, color: "bg-danger" }
];

const decodeBase64Url = (s) => {
  try {
    let b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return atob(b64);
  } catch {
    return null;
  }
};

const resolveImageUrl = (rawUrl) => {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }

  if (u.hostname === 'imgs.search.brave.com') {
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    const decoded = decodeBase64Url(seg);
    if (decoded && /^https?:\/\/.+/i.test(decoded)) return decoded;
  }

  if (/(^|\.)google\./i.test(u.hostname)) {
    const imgurl = u.searchParams.get('imgurl');
    if (imgurl && /^https?:\/\/.+/i.test(imgurl)) return imgurl;
  }

  if (/(^|\.)bing\.com$/i.test(u.hostname)) {
    const mediaurl = u.searchParams.get('mediaurl');
    if (mediaurl && /^https?:\/\/.+/i.test(mediaurl)) return mediaurl;
  }

  return rawUrl;
};

const deriveAssetName = (url) => {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last && /\.[a-z0-9]{2,5}$/i.test(last) && last.length <= 100) return last;
  } catch {}
  return `web-image-${Date.now().toString(36)}`;
};

export const FileDrop = (props) => {
  const {data} = props;

  const [dropping, setDropping] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [previews, setPreviews] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef(null);
  const [files, setFiles] = useState(fileManager.getMappedFiles(props.files));
  const {designerMode} = useDesigner();

  const accept = data.accept || "/*";
  
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const droppedFiles = e.dataTransfer.files;
    setFile(droppedFiles);
  };

   const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(false);
  };

  const makePreviews = (files) => {
    const promises = files.map((file) => new Promise((resolve, reject) => {
      const getSrc = (f) => {
        const fileType = f?.type || "";
        if (fileType.match("video.*")) return URL.createObjectURL(f);
        if (fileType.match("audio.*")) return URL.createObjectURL(f);
        if(fileType.match("image.*")) return URL.createObjectURL(f);
        return null;
      };

      if (file instanceof File) {
        if ((file.type || "").match("image.*")) {
          const reader = new FileReader();
          reader.onload = (e) => {
            resolve({
              name: file.name,
              src: e.target.result,
              previewSrc: e.target.result,
              type: "image",
              rawFile: file,
            });
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        } else {
          resolve({
            name: file.name,
            src: getSrc(file),
            previewSrc: getSrc(file),
            type: "file",
            rawFile: file,
          });
        }
      } else {
        const mappedFile = fileManager.getMappedFiles([file])[0] || file;
        resolve(mappedFile);
      }
    }));

    Promise.all(promises).then((newPreviews) => {
      !isEqual(previews, newPreviews) && setPreviews(newPreviews);
      setLoaded(true);
      setDropping(false);
    }).catch((error) => {
      setLoaded(true);
      setDropping(false);
      loopar.alert("An error occurred while reading the files. Please try again.");
    });
  }
  
  useEffect(() => {
    makePreviews(files);
  }, [files]);

  useEffect(() => {
    loaded && props.onChange && props.onChange({target: {value: previews}});
  }, [previews, loaded]);

  const mergeFiles = (files = [], newFiles) => {
    if (data.multiple) {
      return [...files, ...newFiles].filter((file, index, self) => (
        index === self.findIndex((f) => f.name === file.name && f.size === file.size)
      ));
    }
    return Array.isArray(newFiles) ? [newFiles[0]] : Array.isArray(files) ? [files[0]] : [];
  };
  
  const setFile = (file) => {
    if (file) {
      if (Array.isArray(file)) {
        file.forEach((f) => setFile(f));
        return;
      }

      if (file instanceof FileList) {
        file = Array.from(file);
        file.forEach((f) => setFile(f));
        return;
      }

      let normalizedFile = file;
      if (!(file instanceof File) && typeof file === "object") {
        normalizedFile = fileManager.getMappedFiles([file])[0] || file;
      }

      validateFile(normalizedFile, accept);
      setFiles(prevFiles => mergeFiles([...prevFiles], [normalizedFile]));
    }
  }

  const handleClearFiles = () => {
    loopar.confirm('Are you sure you want to delete all files?', () => {
      setFiles([]);
    });
  };
  
  const hasFiles = previews.length > 0;

  const handleAction = (e, origin) => {
    e.preventDefault();
    e.stopPropagation();
    if(designerMode) return;

    if (origin.name === "Local") return inputRef.current.click();
    if (origin.name === "Server") return setBrowsing(true);
    if (origin.name === "Web") {
      loopar.prompt({
        title: "Web file",
        label: "Enter the URL of the file",
        placeholder: "https://",
        validate: (url) => {
          if (!url) loopar.throw("URL is required");
          if (!url.match(/^https?:\/\/.+/)) loopar.throw("Invalid URL");
          return true;
        },
        ok: (rawUrl) => {
          const url = resolveImageUrl(rawUrl);

          const probe = new Image();
          probe.onload = () => {
            setFile({
              name: deriveAssetName(url),
              src: url,
              type: "image",
              importPending: true,
              importMode: "reference",
            });
          };
          probe.onerror = () => {
            loopar.alert("The URL did not resolve to a valid image.");
          };
          probe.src = url;
        },
      });
    }

    if (origin.name === "Trash") {
      handleClearFiles();
    }
  }

  return (
    <div
      className={`h-full bg-background/50 flex ${!hasFiles ? "flex-col" : "flex-row"} items-center justify-center ${dropping ? "drag-over" : ""}`}
      onDragOverCapture={handleDragOver}
      onDragLeaveCapture={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        type="file"
        className="hidden"
        onChange={(e) => setFile(e.target.files)}
        multiple={data.multiple}
        accept={accept}
        ref={inputRef}
      />
      {dropping ? (
        <div className="w-full flex flex-col items-center text-lg">
          <UploadCloudIcon className="w-12 h-12" />
          {__("Drop files here!")}
        </div>
      ) : (
        loaded ? (
          <>
            {!hasFiles && <div className="mb-2">
              <small className="flex text-lg text-center w-full">
                {__("Drag & Drop or upload from")}
              </small>
            </div>}
            <div className={`flex ${!hasFiles ? "flex-row" : "flex-col"} gap-2`}>
              {(origins).map(origin => {
                if (!hasFiles && origin.name === "Trash") return null;
                const refOrigin = props.origins;
                if (refOrigin && refOrigin.length > 0 && !refOrigin.includes(origin.name)) return null;

                const Icon = origin.icon;
                const size = !hasFiles ? "w-16" : "w-12";
                return (
                  <button
                    key={origin.name}
                    className={`flex ${size} flex-col items-center rounded border bg-card p-2 shadow cursor-pointer transition-colors hover:bg-muted/50`}
                    onClick={(e) => handleAction(e, origin)}
                  >
                    <Icon />
                    {!hasFiles && origin.name}
                  </button>
                );
              })}
            </div>
          </>
        ) : <Loader2Icon className="text-slate-500 w-10 h-10 animate-spin" />
      )}
      <>
        {hasFiles && (
          <FileContainer>
            {previews.map((file) => (
              <FilePreview
                key={file.name}
                file={file}
                onDelete={() => {
                  setFiles(files.filter((f) => f.name !== file.name));
                }}
              />
            ))}
          </FileContainer>
        )}
        {browsing && (
          <FileBrowser
            hasTitle={false}
            onClose={() => setBrowsing(false)}
            onSelect={(file) => {
              setFile(file);
              if(!data.multiple) setBrowsing(false);
            }}
            accept={accept}
            height={512}
            inModal={props.inModal}
          />
        )}
      </>
    </div>
  );
};
