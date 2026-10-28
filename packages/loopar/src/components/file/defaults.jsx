import {ImageIcon} from "lucide-react";
import {
  FaFileZipper, RiFileExcel2Fill, RiFileWord2Fill, BsFillFileEarmarkPdfFill,
  FaFile, FaFileAudio, FaFolder, FaFilePowerpoint, IoVideocamSharp,
} from "./file-type-icons.jsx";
import fileManager, {getExtention} from "./file-manager";
import loopar from "loopar";

export const fileIcons = {
  image: {
    icon: ImageIcon,
    color: "text-primary",
  },
  video: {
    icon: IoVideocamSharp,
    color: "text-primary",
  },
  audio: {
    icon: FaFileAudio,
    color: "text-primary",
  },
  pdf: {
    icon: BsFillFileEarmarkPdfFill,
    color: "text-red-500",
  },
  zip: {
    icon: FaFileZipper,
    color: "text-yellow-500",
  },
  word: {
    icon: RiFileWord2Fill,
    color: "text-blue-500",
  },
  powerpoint: {
    icon: FaFilePowerpoint,
    color: "text-orange-500",
  },
  excel: {
    icon: RiFileExcel2Fill,
    color: "text-green-500",
  },
  archive: {
    icon: FaFileZipper,
    color: "text-yelow-500",
  },
  code: {
    icon: FaFile,
    color: "text-primary",
  },
  text: {
    icon: FaFile,
    color: "text-primary",
  },
  folder: {
    icon: FaFolder,
    color: "text-yellow-500",
  },
  default: {
    icon: FaFile,
    color: "text-primary",
  },
};

export const validateFile = (file, acceptedTypes = "*/*") => {
  const fileType = fileManager.getFileType(file);
  const fileExtension = getExtention(file.name);
  acceptedTypes = Array.isArray(acceptedTypes) ? acceptedTypes : acceptedTypes.split(',');

  if (acceptedTypes.includes('*/*')) {
    return;
  }

  for (let i = 0; i < acceptedTypes.length; i++) {
    const acceptedType = acceptedTypes[i].trim();

    if (acceptedType === fileType || acceptedType === fileExtension) {
      return;
    }

    if (acceptedType.endsWith('/*')) {
      const baseType = acceptedType.slice(0, -2);
      if (fileType.startsWith(baseType)) {
        return;
      }
    }

    if (acceptedType.startsWith('.')) {
      const extWithoutDot = acceptedType.slice(1).toLowerCase();
      // ".pdf" accepts a file named *.pdf, whatever MIME family it reports.
      if (extWithoutDot === String(fileExtension || '').toLowerCase()) return;
      const mimeExtension = fileType.split('/')[1]?.toLowerCase();
      
      const extensionMap = {
        'jpg': ['jpeg', 'jpg'],
        'jpeg': ['jpeg', 'jpg'],
        'png': ['png'],
        'gif': ['gif'],
        'webp': ['webp'],
        'svg': ['svg+xml', 'svg'],
        'pdf': ['pdf'],
      };

      if (extensionMap[extWithoutDot]?.includes(mimeExtension)) {
        return;
      }
    }
  }

  loopar.throw(`File type "${fileType}" (${fileExtension || 'no extension'}) is not supported! Accepted types: ${acceptedTypes.join(', ')}`);
}