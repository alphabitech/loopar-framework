import {Entity as EntityComponent} from "../loader.jsx"
import { __ } from "@global/i18n";

/** Embeds an entity's action (list, create, view…) inside a page. */
const Entity = (props) =>{
  const data = props.data || {};

  if(!data.name || !data.action){
    return (
      <div className="text-sm text-muted-foreground">
        <p>{__("Name and Action are required")}</p>
        <p>{__("Name:")} {data.name}</p>
        <p>{__("Action:")} {data.action}</p>
      </div>
    );
  }

  return (
    <EntityComponent name={data.name} action={data.action}>
      {props.children}
    </EntityComponent>
  )
}

Entity.metaFields = () => {
  return [[
    {
      group: "General",
      elements: {
        name: {
          element: INPUT,
          data: {
            label: "Name",
            description: "Name of Entity"
          }
        },
        action: {
          element: INPUT,
          data: {
            label: "Action in Controller",
            description: "Action in Controller"
          }
        },
      }
    },
  ]];
};

export default Entity
