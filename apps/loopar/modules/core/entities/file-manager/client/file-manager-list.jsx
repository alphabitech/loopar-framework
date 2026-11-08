'use strict';

import { useDocument } from '@loopar/document';
import { ListLayout } from '@loopar/list';
import {loopar} from 'loopar';
import fileManager from "@@file/file-manager";
import FilePreview from "@file-preview";
import FileUploader from "@file-uploader";
import {Button} from "@cn/components/ui/button";
import { UploadIcon, TrashIcon, PencilIcon } from 'lucide-react';
import {Link} from '@link';
import { Avatar, AvatarFallback, AvatarImage } from "@cn/components/ui/avatar";
import {fileIcons} from "@@file/defaults";
import {cn} from "@cn/lib/utils";
import { useTable } from "@@table/TableContext";
import { useDialogContext} from "@dialog";
import Emitter from '@services/emitter/emitter';
import { useEffect, useState } from "react";
import { __ } from "loopar";

const ListenerSelect = ({onSelect}) => {
  useEffect(() => {
    const handleSelect = (src) => {
      onSelect && onSelect(fileManager.getMappedFiles(src));
    }

    Emitter.on('onSelect', handleSelect);
    return () => {
      Emitter.off('onSelect', handleSelect);
    };
  }, []);

  return <></>;
}

const CardFile = ({ data, file }) => {
  const {selectRow, selectedRows} = useTable();

  const handleSelect = (e, selected) => {
    selectRow(data, selected);
  }
  
  return (
    <FilePreview
      data={data}
      file={file}
      selected={selectedRows.includes(data.name)}
      onSelect={handleSelect}
    />
  );
}

const NameRender = ({row}) => {
  const {inDialog} = useDialogContext();
  const {toggleRowSelect} = useTable();

  const type = fileManager.getFileType(row);
  const avatarRoute = `/assets/public${row.extention == "svg" ? "" : "/thumbnails"}`;
  const icon = fileIcons[type] || fileIcons["default"];
  const Icon = icon.icon;
  const color = icon.color;
  const Com = inDialog ? "a" : Link;

  const compPropperties = inDialog ? {
    onClick: (e) => {
      e.preventDefault();
      toggleRowSelect(row);
    }
  } : {}

  return (
    <Com className='flex flex-row' to={`view?name=${row.name}&app=${row.app}`} {...compPropperties}>
      <Avatar>
        <AvatarImage src={`${avatarRoute}/${row.name}`} style={{objectFit: "contain"}}/>
        <AvatarFallback>
          <Icon
            className={cn(`w-full p-3 h-full object-cover transition-all ease-in duration-300 hover:scale-105 aspect-square`, color)}
          />
        </AvatarFallback>
      </Avatar>
      <div className='flex flex-col items-start p-0 pl-3'>
        {row.name}
        <span className='text-gray-500'>{fileManager.getFileSize(row.size)}</span>
      </div>
    </Com>
  )
}

const Buttons = ({row}) => {
  const {inDialog} = useDialogContext();

  if(inDialog) {
    return null
  }
  
  return (
    <div className="flex flex-row items-center gap-0">
      <Button
        variant="outline"
        onClick={(e) => {
          e.preventDefault();
          loopar.confirm(`Are you sure you want to delete ${row.name}?`, () => {
            loopar.call("File Manager", "delete", {
              query: {
                file_name: row.name,
                app: row.app,
              },
              success: () => {
                loopar.refresh();
              },
              error: (message) => {
                loopar.throw(message);
              },
            });
          });
        }}
      >
        <TrashIcon className="text-red-500" />
      </Button>
      <Link
        to={`update?name=${row.name}&app=${row.app}`}
      >
        <Button variant="outline">
          <PencilIcon className="text-blue-500" />
        </Button>
      </Link>
    </div>
  );
}

const columns = (baseColumns) => [
  {
    data: {
      name: "name:",
    },
    render: row => (
      <NameRender row={row} />
    ),
  },
  ...baseColumns.filter(col => !["type", "size", "extention"].includes(col.data.name)),
  {
    data: {
      label: "...",
      name: "actions",
    },
    headProps: {
      className: "w-10 p-2 text-center",
    },
    render: row => (
      <Buttons row={row} />
    ),
  }
];

const gridTemplate = (row) => {
  const file = fileManager.getMappedFiles([row])[0];
  return <CardFile data={row} file={file} />;
};

/**
 * File Manager list. `onlyGrid` / `onSelect` come from the opener when the
 * list is embedded as a picker (file inputs); standalone it is a plain desk
 * list with an Upload primary action.
 */
export default function FileManagerList() {
  const { ctrl } = useDocument();
  const { onSelect } = ctrl.props;
  const [uploading, setUploading] = useState(false);

  const primaryAction = (
    <Button
      variant="secondary"
      onClick={(e) => {
        e.preventDefault();
        setUploading(true);
      }}
    >
      <UploadIcon className="pr-1" />
      {__("Upload")}
    </Button>
  );

  return (
    <ListLayout columns={columns} gridTemplate={gridTemplate} primaryAction={primaryAction}>
      <ListenerSelect onSelect={onSelect} />
      {uploading ? (
        <FileUploader
          data={{
            name: "file",
            label: "File",
            placeholder: "Select file",
            accept: "*",
            multiple: true,
          }}
          inModal={true}
          onUpload={() => {
            loopar.navigate("list");
          }}
          onClose={() => {
            setUploading(false);
          }}
          buttons={[]}
        />
      ) : null}
    </ListLayout>
  );
}
