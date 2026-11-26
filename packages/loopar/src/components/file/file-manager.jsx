import elementManage from "@@tools/element-manage";
import { versioned, unversioned } from "@global/assets-version";

export const getExtention = (file = "") => {
  const match = file.match(/\.([a-z0-9]+)$/i);
  if (match) return match[1].toLowerCase();

  if (file.includes('http')) {
    const cloudinaryMatch = file.match(/\/(?:image|video|raw|auto)\/(upload|fetch)\//i);
    if (cloudinaryMatch) {
      const type = file.match(/\/(image|video|raw|auto)\//i)?.[1];
      if (type === 'image') return 'jpg';
      if (type === 'video') return 'mp4';
      if (type === 'raw') return 'pdf';
    }

    const urlMatch = file.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
    if (urlMatch) return urlMatch[1].toLowerCase();
  }

  return '';
};

class FileManager {
  groupElement = FILE_INPUT;
  inputType = 'file';
  fileIcons = {
    image: { icon: 'fas fa-file-image', color: 'primary' },
    video: { icon: 'fas fa-file-video', color: 'danger' },
    audio: { icon: 'fas fa-file-audio', color: 'warning' },
    pdf: { icon: 'fas fa-file-pdf', color: 'danger' },
    word: { icon: 'fas fa-file-word', color: 'primary' },
    excel: { icon: 'fas fa-file-excel', color: 'success' },
    powerpoint: { icon: 'fas fa-file-powerpoint', color: 'danger' },
    zip: { icon: 'fa fa-file-archive', color: 'yellow' },
    code: { icon: 'fas fa-file-code', color: 'secondary' },
    text: { icon: 'fas fa-file-alt', color: 'secondary' },
    default: { icon: 'fas fa-file', color: 'secondary' },
    folder: { icon: 'fas fa-folder', color: 'yellow' },
    application: { icon: 'fas fa-file', color: 'secondary' }
  };

  fileExtensions = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'svg', 'bmp', 'ico', 'webp', 'tiff', 'tif', 'psd', 'ai', 'raw', 'indd', 'heif', 'heic', 'eps', 'svgz', 'jfif'],
    video: ['mp4', 'avi', 'mkv', 'webm', 'mov', 'flv', 'wmv', 'mpg', 'mpeg', '3gp', '3g2', 'm4v', 'h264', 'rmvb', 'vob', 'ts', 'm2ts', 'mts', 'divx', 'xvid', 'asf', 'ogv', 'rm', 'swf', 'f4v', 'dat', 'm2v', 'mpeg1', 'mpeg2', 'mpeg4', 'vcd', 'svcd', 'dvd', 'm1v', 'm2p', 'm2ts', 'm2v', 'm4e', 'mjp', 'mjpeg', 'mod', 'movie', 'mp21', 'mpe', 'mpv', 'ogx', 'qt', 'viv', 'vivo', 'vob', 'vro', 'xlmv'],
    audio: ['mp3', 'wav', 'ogg', 'm4a', 'wma', 'flac', 'aac', 'aiff', 'alac', 'pcm', 'dsd', 'awb', 'ac3', 'dts', 'mp2', 'mka', 'm3u', 'm3u8', 'opus', 'ra', 'rm', 'tta', 'wv', 'webm', 'caf', 'amr', 'mpc', 'mid', 'midi', 'log', 'cue', 'aif', 'aifc', 'cda', 'dct', 'dss', 'dvf', 'gsm', 'm3u', 'pls', 'sln', 'vox', 'wma', 'wpl', 'zab', 'm4b', 'm4p', 'oga', 'mogg', 'spx', 'opus', '3gp', 'aa', 'aax', 'act', 'aiff', 'alac', 'amr', 'ape', 'au', 'awb', 'dct', 'dss', 'dvf', 'flac', 'gsm', 'iklax', 'ivs', 'm4a', 'm4b', 'm4p', 'mmf', 'mpc', 'msv', 'nmf', 'nsf', 'ogg', 'oga', 'mogg', 'opus', 'ra', 'rm', 'raw', 'rf64', 'sln', 'tta', 'voc', 'vox', 'wav', 'wma', 'wv', 'webm', '8svx', 'cda', 'm3u', 'pls', 'spx', 'wpl', 'zab'],
    pdf: ['pdf', 'ps'],
    word: ['doc', 'docx'],
    excel: ['xls', 'xlsx'],
    powerpoint: ['ppt', 'pptx'],
    zip: ['zip', 'rar', '7z', 'tar'],
    code: ['html', 'css', 'js', 'php', 'py', 'java', 'cpp', 'c', 'cs', 'go', 'ts', 'tsx', 'jsx', 'rb', 'sh', 'bat', 'cmd'],
    text: ['txt', 'md'],
    application: ['exe', 'msi', 'apk', 'dmg', 'iso', 'bin', 'jar', 'deb', 'rpm', 'appimage', 'run', 'app', 'ipa', 'xap', 'xapk', 'msix', 'msixbundle', 'msixupload', 'msixbundleupload', 'msixupload', 'msixbundleupload', 'msixbq', 'dll'],
  }

  getIconByExtention(ext, type) {
    if (type === 'folder') {
      return this.fileIcons['folder'];
    }

    for (const [key, value] of Object.entries(this.fileExtensions)) {
      if (value.includes(ext)) {
        return this.fileIcons[key];
      }
    }

    return this.fileIcons['default'];
  }

  getTypeByExtension(ext) {
    for (const [key, value] of Object.entries(this.fileExtensions)) {
      if (value.includes(ext)) {
        return key;
      }
    }

    return 'default';
  }

  getTypeFromURL(url) {
    if (url.includes('cloudinary.com')) {
      if (url.includes('/image/')) return 'image';
      if (url.includes('/video/')) return 'video';
      if (url.includes('/raw/')) return 'application';
    }

    const imagePatterns = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)/i;
    const videoPatterns = /\.(mp4|webm|ogg|avi|mov)/i;
    const audioPatterns = /\.(mp3|wav|ogg|m4a)/i;

    if (imagePatterns.test(url)) return 'image';
    if (videoPatterns.test(url)) return 'video';
    if (audioPatterns.test(url)) return 'audio';

    return null;
  }

  getFileType(file) {
    if (!file) return null;
    
    if (elementManage.isJSON(file)) {
      file = JSON.parse(file);
    }

    if (file.type && file.type !== "folder") {
      if (this.fileIcons[file.type]) {
        return file.type;
      }
      
      if (file.type.includes('/')) {
        const mimeCategory = file.type.split('/')[0];
        if (this.fileIcons[mimeCategory]) {
          return mimeCategory;
        }
      }
    }

    if (file.type === "folder") {
      return "folder";
    }

    const ext = getExtention(file.name);
    if (ext) {
      return this.getTypeByExtension(ext);
    }

    if (typeof file.name === 'string' && file.name.includes('http')) {
      const urlType = this.getTypeFromURL(file.name);
      if (urlType) return urlType;
    }

    if (file.src && typeof file.src === 'string' && file.src.includes('http')) {
      const urlType = this.getTypeFromURL(file.src);
      if (urlType) return urlType;
    }

    return 'default';
  }

  getFileSize(bytes, decimals = 2) {
    const n = parseInt(bytes);
    if (!Number.isFinite(n)) return ['—', ''];
    if (n === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    const i = Math.floor(Math.log(n) / Math.log(k));

    return [parseFloat((n / Math.pow(k, i)).toFixed(dm)), sizes[i]];
  }

  getFileIcon(type) {
    return this.fileIcons[type] ? this.fileIcons[type].icon : this.fileIcons['default'].icon;
  }

  isURL(str) {
    var regex = /^(https?:\/\/)?([\w-]+\.)+([a-z]{2,})(\/\S*)?$/;
    return regex.test(str);
  }

  parseSerializedFiles(value) {
    let parsed = value;
    for (let i = 0; i < 3; i++) {
      if (typeof parsed === "string" && elementManage.isJSON(parsed)) {
        parsed = JSON.parse(parsed);
        continue;
      }
      break;
    }
    return parsed;
  }

  getMappedFiles(files = []) {
    files = this.parseSerializedFiles(files);

    if (typeof files === "string" && !elementManage.isJSON(files)) {
      if (this.isURL(files) || files.startsWith("/") || files.startsWith("data:")) {
        const detectedType = this.getTypeFromURL(files) || "image";
        const ext = getExtention(files) || (detectedType === 'image' ? 'jpg' : 'file');
        
        files = [{
          name: files,
          src: files,
          type: detectedType,
          extention: ext,
          previewSrc: files
        }];
      } else {
        files = [files];
      }
    }

    if (files instanceof File) {
      files = FileList(files);
    }

    if (typeof files === "string" && elementManage.isJSON(files)) {
      files = this.parseSerializedFiles(files);
    }

    if (files && typeof files == "object") {
      files = Object.values(files);
    }

    if (typeof files == "object" && !Array.isArray(files)) {
      files = [];
    }

    return (files || []).filter(file => (typeof file == "object" && file.name) && !Array.isArray(file)).map(file => {
      const normalizedName = this.decodeFileName(file.name);
      const ext = getExtention(file.name);
      const fileType = this.getFileType(file);

      const previewSrc = file.previewSrc
        ? versioned(encodeURI(file.previewSrc))
        : this.getSrc(file, true, ext);

      return file instanceof File ? file : {
        ...file,
        name: normalizedName,
        type: fileType,
        src: this.getSrc(file),
        extention: ext || (fileType === 'image' ? 'jpg' : 'file'),
        previewSrc
      };
    });
  }

  decodeFileName(name = "") {
    if (typeof name !== "string") return name;
    try {
      return decodeURIComponent(name)
        .normalize("NFKC")
        .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    } catch (_) {
      return name
        .normalize("NFKC")
        .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  encodeFileName(name = "") {
    if (typeof name !== "string") return name;
    return encodeURIComponent(this.decodeFileName(name));
  }

  encodePath(path = "") {
    if (typeof path !== "string") return "";
    return path
      .split("/")
      .map((part) => encodeURIComponent(this.decodeFileName(part)))
      .join("/");
  }

  getSrc(file, preview = false, ext = null) {
    if (file.src && (file.src.includes("data:") || file.src.includes("http"))) {
      return encodeURI(file.src);
    }

    if (typeof file?.src === "string" && file.src.startsWith("/")) {
      const normalizedSrc = unversioned(file.src.startsWith("/uploads/")
        ? file.src.replace("/uploads/", "/assets/")
        : file.src);
      return versioned(this.encodePath(normalizedSrc));
    }

    return versioned("/assets/public/" + ((preview && !["svg", "ico"].includes(ext)) ? "thumbnails/" : "") + this.encodeFileName(file.name));
  }

  getImage(data = {}, field, avatar = null) {
    const img = this.getMappedFiles((data || {})[field])[0];
    return img ? img.previewSrc : avatar ? `/assets/public/avatars/${avatar}` : null;
  }
}

const fileManager = new FileManager();

export default fileManager;

export const getImage = (data = {}, field, avatar = null) => {
  const img = fileManager.getMappedFiles((data || {})[field])[0];
  return img ? img.previewSrc : avatar ? `/assets/public/avatars/${avatar}` : null;
};