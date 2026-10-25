import { format as Format, setHours, setMinutes, setSeconds } from 'date-fns';

// 'YYYY-MM-DD' (optionally with a time, no zone): `new Date()` reads a bare
// date as UTC midnight, which west of UTC is the previous local day — every
// save of a record moved its dates one day back. Read it as a local date.
// Values with a zone (ISO 'Z' / offset) are real instants: parsed as such.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;
const localDate = (value) => {
  const m = typeof value === "string" && value.match(DATE_ONLY);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(value);
};

const getDate = (date=new Date(), format) => {
  if(!date) return null;

  if(format){
    if(typeof date !== "string" && typeof date !== "object") return null;

    date = localDate(date);
    if(isNaN(date.getTime())) return null;

    return Format(date, format === "DB" ? 'yyyy-MM-dd' : format);
  }

  return typeof date === "object" ? date : localDate(date);
}

const getDateTime = (date=new Date(), format) => {
  if (!date) return null;

  if (format) {
    if (typeof date !== "string" && typeof date !== "object") return null;

    date = new Date(date);
    if(isNaN(date.getTime())) return null;

    return Format(date, format === "DB" ? 'yyyy-MM-dd HH:mm:ss' : format);
  }

  return typeof date === "object" ? date : new Date(date);
}

const getTime = (date = new Date(), format) => {
  if(!date || date == "Invalid Date") return null;
  let time = typeof date === "string" ? new Date(date) : date;

  if(typeof date === "string"){
    if(time == "Invalid Date"){
      const [hours, minutes, seconds] = date.split(":");
    
      if(hours && minutes){
        time = new Date();
        time = setHours(time, hours);
        time = setMinutes(time, minutes);
        //time = setSeconds(time, "00");
      }else{
        time = null;
      }
    }
  }

  time = setSeconds(time, "00");
  
  if (format) {
    format = format === "DB" ? 'HH:mm:ss' : format;

    return Format(time, format);
  }

  return time;
}

export {
  getDate,
  getDateTime,
  getTime
}