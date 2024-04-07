import { MIInfo, MINode } from "./backend/mi_parse";

export function isKernelPath(path: string): boolean {
  return true;//TODO
}

//used when SET a breakpoint, NOT breakpoint hit
export function isKernelBreakpoint(info: MINode): boolean {
  return isKernelPath(getPathFromMINode(info));
}

//       /------------------------------------------------------------------------------------------_
//      /  This is bruteforce and ugly but the MINode is already a huge mess so I have to do this   /
//     /-------------------------------------------------------------------------------------------/
//   😅
export function getAddrFromMINode(info: MINode): string | undefined {
  let dfsCheckAddr = (obj: any): string | undefined => {
    for (let key in obj) {
      let value=obj[key];
      if (Array.isArray(value)) {
        if (value.length === 2 && value[0] === "addr") {
          return value[1];
        }
      }
      if (typeof value === "object") {
        let res = dfsCheckAddr(value);
        if (res != undefined) {
          return res;
        }
      }
    }
    return undefined;
  }
  for (let output of info.outOfBandRecord) {
    let res = dfsCheckAddr(output);
    if (res != undefined) {
      return res;
    }
  }
  
  return dfsCheckAddr(info.resultRecords.results);
}

export function getPathFromMINode(info: MINode): string {
  let dfsCheckAddr = (obj: any): string | undefined => {
    for (let key in obj) {
      let value=obj[key];
      if (Array.isArray(value)) {
        if (value.length === 2 && value[0] === "fullname") {
          return value[1];
        }
      }
      if (typeof value === "object") {
        let res = dfsCheckAddr(value);
        if (res != undefined) {
          return res;
        }
      }
    }
    return undefined;
  }
  for (let output of info.outOfBandRecord) {
    let res = dfsCheckAddr(output);
    if (res != undefined) {
      return res;
    }
  }
  return dfsCheckAddr(info.resultRecords.results);
}



export const prettyPrintJSON = (obj:any) => JSON.stringify( obj, (key, val) => (val instanceof Array) ? JSON.stringify(val) : val, 2).replace(/\\/g, '').replace(/\[/g, '[').replace(/\]/g,']').replace(/\{/g, '{').replace(/\}/g,'}');