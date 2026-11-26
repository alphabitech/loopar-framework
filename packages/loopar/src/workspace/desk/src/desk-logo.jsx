import React from "react";
import { versioned } from "@global/assets-version";

export const DeskLogo = (props) => {
  const imageProps = {
    src: versioned("/assets/public/images/loopar.svg"),
    alt: "Loopar Logo",
    className: 'hidden h-6 md:block text-white',
    href: "/desk",
  }
  return (
    <div className='p-1'>
      <div
        className='inline-flex items-center'
      >
        <img 
          {...imageProps}
          loading="lazy"
          decoding="async"
        />
        <img {...imageProps} 
          src={versioned("/assets/public/images/logo-dark-min.svg")} 
          className="h-6 w-20 md:hidden" 
          style={{minWidth:40, maxWidth:40}}
          loading="lazy"
          decoding="async"
        />
      </div>
    </div>
  );
};
