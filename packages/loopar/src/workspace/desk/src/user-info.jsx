
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu"

import { Link } from "@link"
import { buttonVariants } from "@cn/components/ui/button"
import { User2Icon, UserRoundCogIcon, LogOutIcon, Globe2Icon } from "lucide-react"
import { __ } from "@global/i18n";

const MakeButton = ({ Icon, text, link, notControlled, onClick, ...props }) => (
  <Link
    {...props}
    to={link}
    variant="ghost"
    notControlled={notControlled}
    {...(onClick ? {onClick} : {})}
  >
    <Icon className="h-7 w-7 mr-2" />
    {text}
  </Link>
)

export function UserInfo() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <div
          className={`${buttonVariants({
            size: "icon",
            variant: "ghost",
          })} cursor-pointer`}
        >
          <User2Icon />
          <span className="sr-only">{__("User")}</span>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <div className="grid grid-cols-1 p-2">
          <MakeButton Icon={UserRoundCogIcon} text="Profile" link="/desk/Profile/update" />
          <MakeButton Icon={LogOutIcon} text="Log Out" link="/auth/logout" notControlled="true" award={false}/>
          <MakeButton Icon={Globe2Icon} text="Web Site" link="/" award={false} target="_blank" />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
