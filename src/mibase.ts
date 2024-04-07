import * as DebugAdapter from 'vscode-debugadapter';
import { DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, ThreadEvent, OutputEvent, ContinuedEvent, Thread, StackFrame, Scope, Source, Handles } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Breakpoint, IBackend, Variable, VariableObject, ValuesFormattingMode, MIError } from './backend/backend';
import { MINode } from './backend/mi_parse';
import { expandValue, isExpandable } from './backend/gdb_expansion';
import { MI2 } from './backend/mi2/mi2';
import { execSync } from 'child_process';
import * as systemPath from "path";
import * as net from "net";
import * as os from "os";
import * as fs from "fs";
import * as vscode from "vscode";

import { SourceFileMap } from "./source_file_map";
import { Address } from "cluster";
import { strict } from "assert";
import { debugPort } from "process";
import { RISCV_REG_NAMES } from "./frontend/consts";
import {getAddrFromMINode, isKernelBreakpoint, isKernelPath} from "./utils";


class ExtendedVariable {
	constructor(public name: string, public options: { "arg": any }) {
	}
}

class VariableScope {
	constructor(public readonly name: string, public readonly threadId: number, public readonly level: number) {
	}

	public static variableName(handle: number, name: string): string {
		return `var_${handle}_${name}`;
	}
}

export enum RunCommand {
	CONTINUE,
	RUN,
	NONE,
}

class AddressSpace {
	name: string;
	setBreakpointsArguments: DebugProtocol.SetBreakpointsArguments[];
	constructor(name: string, setBreakpointsArguments: DebugProtocol.SetBreakpointsArguments[]) {
		this.name = name;
		this.setBreakpointsArguments = setBreakpointsArguments;
	}
}
//负责断点缓存，转换等
class AddressSpaces {
	protected spaces: AddressSpace[];
	protected currentSpaceName: string;
	protected debugSession: MI2DebugSession;
	constructor(currentSpace: string, debugSession: MI2DebugSession) {
		this.debugSession = debugSession;
		this.spaces = [];
		this.spaces.push(new AddressSpace(currentSpace, []));
		this.currentSpaceName = currentSpace;
	}
	//将当前空间的断点清除（缓存不清除）
	public disableCurrentSpaceBreakpoints() {
		let currentIndex = -1;
		for (let j = 0; j < this.spaces.length; j++) {
			if (this.spaces[j].name === this.currentSpaceName) {
				currentIndex = j;
			}
		}
		//假设this.spaces内缓存的断点信息和GDB里真实的断点信息完全一致。理论上确实是完全一致的。
		//未来可以尝试令gdb删除某个文件里的所有断点
		if (currentIndex === -1) {
			//别写成=
			return;
		}
		this.spaces[currentIndex].setBreakpointsArguments.forEach((e) => {
			this.debugSession.miDebugger.clearBreakPoints(e.source.path);
			this.debugSession.sendEvent({
				event: "showInformationMessage",
				body: "disableCurrentSpaceBreakpoints successed. index= " + currentIndex,
			} as DebugProtocol.Event);
		});
	}
	//功能和disableCurrentSpaceBreakpoints有重合。可考虑精简代码
	//断点被触发时会调用该函数。如果空间发生变化（如kernel=>'src/bin/initproc.rs'）
	//缓存旧空间的断点，清除旧空间的断点，加载新空间的断点
	public updateCurrentSpace(updateTo: string) {
		let newIndex = -1;
		for (let i = 0; i < this.spaces.length; i++) {
			if (this.spaces[i].name === updateTo) {
				newIndex = i;
			}
		}
		if (newIndex === -1) {
			this.spaces.push(new AddressSpace(updateTo, []));
			newIndex = this.spaces.length - 1;
		}
		let oldIndex = -1;
		for (let j = 0; j < this.spaces.length; j++) {
			if (this.spaces[j].name === this.currentSpaceName) {
				oldIndex = j;
			}
		}
		if (oldIndex === -1) {
			this.spaces.push(new AddressSpace(this.currentSpaceName, []));
			oldIndex = this.spaces.length - 1;
		}
		this.spaces[oldIndex].setBreakpointsArguments.forEach((e) => {
			this.debugSession.miDebugger.clearBreakPoints(e.source.path);
		});
		this.spaces[newIndex].setBreakpointsArguments.forEach((args) => {
			this.debugSession.miDebugger.clearBreakPoints(args.source.path).then(
				() => {
					let path = args.source.path;
					if (this.debugSession.isSSH) {
						// convert local path to ssh path
						path = this.debugSession.sourceFileMap.toRemotePath(path);
					}
					const all = args.breakpoints.map((brk) => {
						return this.debugSession.miDebugger.addBreakPoint({
							file: path,
							line: brk.line,
							condition: brk.condition,
							countCondition: brk.hitCondition,
						});
					});
				},
				(msg) => {
					//TODO
				}
			);
		});
		this.currentSpaceName = this.spaces[newIndex].name;


	}
	public getCurrentSpaceName() {
		return this.currentSpaceName;
	}
	///当设置一新断点时会调用该函数。将断点信息保存到对应的空间中。
	public saveBreakpointsToSpace(args: DebugProtocol.SetBreakpointsArguments, spaceName: string) {
		let found = -1;
		for (let i = 0; i < this.spaces.length; i++) {
			if (this.spaces[i].name === spaceName) {
				found = i;
			}
		}
		if (found === -1) {
			this.spaces.push(new AddressSpace(spaceName, []));
			found = this.spaces.length - 1;
		}
		let alreadyThere = -1;
		for (let i = 0; i < this.spaces[found].setBreakpointsArguments.length; i++) {
			if (this.spaces[found].setBreakpointsArguments[i].source.path === args.source.path) {
				this.spaces[found].setBreakpointsArguments[i] = args;
				alreadyThere = i;
			}
		}
		if (alreadyThere === -1) {
			this.spaces[found].setBreakpointsArguments.push(args);
		}
	}
	///仅用于reset
	public removeAllBreakpoints() {
		this.spaces = [];
	}
	public status() {
		return JSON.stringify({
			current: this.currentSpaceName,
			spaces: this.spaces,
		});
	}
}

enum privilegeLevel{
	kernel,
	user,
	unknown,
	hypervisor//not yet supported
}

class SteppingStatus{
	isStepping:boolean;
	steppingTo:privilegeLevel|null=null
}

/// Debug Adapter
export class MI2DebugSession extends DebugSession {
	protected variableHandles = new Handles<
		VariableScope | string | VariableObject | ExtendedVariable
	>();
	protected variableHandlesReverse: { [id: string]: number } = {};
	protected scopeHandlesReverse: { [key: string]: number } = {};
	protected useVarObjects: boolean;
	protected quit: boolean;
	protected attached: boolean;
	protected initialRunCommand: RunCommand;
	protected stopAtEntry: boolean | string;
	public isSSH: boolean;
	public sourceFileMap: SourceFileMap;
	protected started: boolean;
	protected crashed: boolean;
	public miDebugger: MI2;
	protected commandServer: net.Server;
	protected serverPath: string;
	protected running: boolean = false;
	protected addressSpaces = new AddressSpaces("kernel", this); //for rCore
	public KERNEL_IN_BREAKPOINTS_LINE:number;//TODO THIS SHOULD HAVE BEEN IN gdb.ts. However Codes that uses those stuff are all in mibase.ts. :(
	public KERNEL_OUT_BREAKPOINTS_LINE:number;
	public GO_TO_KERNEL_LINE:number;
	public KERNEL_IN_BREAKPOINTS_FILENAME:string;//those names are really confusing :(
	public KERNEL_OUT_BREAKPOINTS_FILENAME:string;
	public GO_TO_KERNEL_FILENAME:string;
	public kernel_memory_ranges:string[][];
	public user_memory_ranges:string[][];
	public steppingStatus:SteppingStatus={isStepping:false,steppingTo:null};//是否在不停地单步
	public currentAddr:number;
	public privilegeLevelJustChanged:boolean=false;
	public currentPrivilegeLevel:privilegeLevel=privilegeLevel.kernel;



	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);
	}

	protected initDebugger() {
		this.miDebugger.on("launcherror", this.launchError.bind(this));
		this.miDebugger.on("quit", this.quitEvent.bind(this));
		this.miDebugger.on("exited-normally", this.quitEvent.bind(this));
		this.miDebugger.on("stopped", this.stopEvent.bind(this));
		this.miDebugger.on("msg", this.handleMsg.bind(this));
		this.miDebugger.on("breakpoint", this.handleBreakpoint.bind(this));
		this.miDebugger.on("watchpoint", this.handleBreak.bind(this)); // consider to parse old/new, too (otherwise it is in the console only)
		this.miDebugger.on("step-end", this.handleBreak.bind(this));
		//this.miDebugger.on("step-out-end", this.handleBreak.bind(this));  // was combined into step-end
		this.miDebugger.on("step-other", this.handleBreak.bind(this));
		this.miDebugger.on("signal-stop", this.handlePause.bind(this));
		this.miDebugger.on("thread-created", this.threadCreatedEvent.bind(this));
		this.miDebugger.on("thread-exited", this.threadExitedEvent.bind(this));
		this.miDebugger.once("debug-ready", () => this.sendEvent(new InitializedEvent()));
		/* czy
		vscode.debug.registerDebugAdapterTrackerFactory('*', {
			createDebugAdapterTracker() {
			  return {
				onWillReceiveMessage: () => that.sendEvent({ event: "customEvent", body: ["testsRoot"] } as DebugProtocol.Event),
				onDidSendMessage:() => that.sendEvent({ event: "customEvent", body: ["testsRoot"] } as DebugProtocol.Event)
			  };
			}
		  });
		  */
		try {
			this.commandServer = net.createServer((c) => {
				c.on("data", (data) => {
					const rawCmd = data.toString();
					const spaceIndex = rawCmd.indexOf(" ");
					let func = rawCmd;
					let args = [];
					if (spaceIndex != -1) {
						func = rawCmd.substring(0, spaceIndex);
						args = JSON.parse(rawCmd.substring(spaceIndex + 1));
					}
					Promise.resolve((this.miDebugger as any)[func].apply(this.miDebugger, args)).then(data => {
						c.write(data.toString());
					});
				});
			});
			this.commandServer.on("error", (err) => {
				if (process.platform != "win32")
					this.handleMsg(
						"stderr",
						"Code-Debug WARNING: Utility Command Server: Error in command socket " +
							err.toString() +
							"\nCode-Debug WARNING: The examine memory location command won't work"
					);
			});
			if (!fs.existsSync(systemPath.join(os.tmpdir(), "code-debug-sockets")))
				fs.mkdirSync(systemPath.join(os.tmpdir(), "code-debug-sockets"));
			this.commandServer.listen(
				(this.serverPath = systemPath.join(
					os.tmpdir(),
					"code-debug-sockets",
					(
						"Debug-Instance-" + new Date(Date.now())
					) /*Math.floor(Math.random() * 36 * 36 * 36 * 36).toString(36)*/
						.toLowerCase()
				))
			);
		} catch (e) {
			if (process.platform != "win32")
				this.handleMsg(
					"stderr",
					"Code-Debug WARNING: Utility Command Server: Failed to start " +
						e.toString() +
						"\nCode-Debug WARNING: The examine memory location command won't work"
				);
		}
	}

	// verifies that the specified command can be executed
	protected checkCommand(debuggerName: string): boolean {
		try {
			const command = process.platform === 'win32' ? 'where' : 'command -v';
			execSync(`${command} ${debuggerName}`, { stdio: 'ignore' });
			return true;
		} catch (error) {
			return false;
		}
	}

	protected setValuesFormattingMode(mode: ValuesFormattingMode) {
		switch (mode) {
			case "disabled":
				this.useVarObjects = true;
				this.miDebugger.prettyPrint = false;
				break;
			case "prettyPrinters":
				this.useVarObjects = true;
				this.miDebugger.prettyPrint = true;
				break;
			case "parseText":
			default:
				this.useVarObjects = false;
				this.miDebugger.prettyPrint = false;
		}
	}

	protected handleMsg(type: string, msg: string) {
		if (type == "target") type = "stdout";
		if (type == "log") type = "stderr";
		this.sendEvent(new OutputEvent(msg, type));
	}

	/*
example: {"token":43,"outOfBandRecord":[],"resultRecords":{"resultClass":"done","results":[["threads",[[["id","1"],["target-id","Thread 1.1"],["details","CPU#0 [running]"],["frame",[["level","0"],["addr","0x0000000000010156"],["func","initproc::main"],["args",[]],["file","src/bin/initproc.rs"],["fullname","/home/czy/rCore-Tutorial-v3/user/src/bin/initproc.rs"],["line","13"],["arch","riscv:rv64"]]],["state","stopped"]]]],["current-thread-id","1"]]}}
*/
	protected handleBreakpoint(info: MINode) {
		this.updateCurrentAddrAtStop(info);
		const event = new StoppedEvent("breakpoint", parseInt(info.record("thread-id")));
		(event as DebugProtocol.StoppedEvent).body.allThreadsStopped =
			info.record("stopped-threads") == "all";
		this.sendEvent(event);
		//this.sendEvent({ event: "info", body: info } as DebugProtocol.Event);
		//TODO only for rCore currently
		if (
			this.addr2privilege(Number(getAddrFromMINode(info)))===privilegeLevel.kernel
		) {
			this.addressSpaces.updateCurrentSpace("kernel");
			this.sendEvent({ event: "inKernel" } as DebugProtocol.Event);
			if (
				info.outOfBandRecord[0].output[3][1][3][1] === this.KERNEL_OUT_BREAKPOINTS_FILENAME &&
				info.outOfBandRecord[0].output[3][1][5][1] === this.KERNEL_OUT_BREAKPOINTS_LINE+""
			) {
				this.sendEvent({ event: "kernelToUserBorder" } as DebugProtocol.Event);
			}else if(info.outOfBandRecord[0].output[3][1][3][1] === "src/syscall/process.rs" &&
			info.outOfBandRecord[0].output[3][1][5][1] === "49")//TODO hardcoded
			{
				this.miDebugger.sendCliCommand("p path").then((result)=>{
					
					let info=this.miDebugger.getMIinfo(result.token);
					
					const pname_ = /(?<=")(.*?)(?=\\)/g;
					let info1=JSON.stringify(info);
					this.sendEvent({ event: "showInformationMessage", body: "info.length-1= "+(info.length-1).toString()  } as DebugProtocol.Event);
					let all_info="";
					for(let i=info.length-1;i>=0;i--){
						all_info=all_info + info[i].outOfBandRecord[0].content;
					}
					this.sendEvent({ event: "showInformationMessage", body: "all info: "+all_info  } as DebugProtocol.Event);
					let addr_regex=/(0x|0X)[a-fA-F0-9]{8}/;
					let pname0_addr=all_info.match(addr_regex)[0].toString();
					this.sendEvent({ event: "newProcessNameAddr", body: pname0_addr  } as DebugProtocol.Event);

					// let len_regex = /(?<= len: )[0-9]+/;
					// let pname0_len=all_info.match(len_regex)[0].toString();

					// let pname=pname0.slice(0,10);
					// this.sendEvent({ event: "get_pname", body: pname } as DebugProtocol.Event);
					
		})
	}
		} else {
			const userProgramName = info.outOfBandRecord[0].output[3][1][4][1];
			this.addressSpaces.updateCurrentSpace(userProgramName);
			this.sendEvent({
				event: "inUser",
				body: { userProgramName: userProgramName },
			} as DebugProtocol.Event);

		}
	}
	/// update currentAddr, currentPrivilegeLevel, privilegeLevelJustChanged
	public updateCurrentAddrAtStop(info:MINode) {
		this.currentAddr = Number(getAddrFromMINode(info));
		let newCurrentPrivilegeLevel = this.addr2privilege(this.currentAddr);
		
		if (newCurrentPrivilegeLevel !== this.currentPrivilegeLevel){
			this.privilegeLevelJustChanged=true;
		}else{
			this.privilegeLevelJustChanged=false;
		}
		this.currentPrivilegeLevel = newCurrentPrivilegeLevel;
	}

	protected handleBreak(info?: MINode) {
		this.updateCurrentAddrAtStop(info);
		const event = new StoppedEvent("step", info ? parseInt(info.record("thread-id")) : 1);
		(event as DebugProtocol.StoppedEvent).body.allThreadsStopped = info
			? info.record("stopped-threads") == "all"
			: true;
		this.sendEvent(event);
	}

	protected handlePause(info: MINode) {
		this.updateCurrentAddrAtStop(info);
		const event = new StoppedEvent("user request", parseInt(info.record("thread-id")));
		(event as DebugProtocol.StoppedEvent).body.allThreadsStopped =
			info.record("stopped-threads") == "all";
		this.sendEvent(event);
	}

	/*example of info:
	 {"token":23,"outOfBandRecord":
	 [{"isStream":false,"type":"exec","asyncClass":"stopped","output":
	 [["reason","end-stepping-range"],["frame",[["addr","0xffffffc0802cb77e"],["func","axtask::task::first_into_user"],["args",[[["name","kernel_sp"],["value","18446743801062787952"]],[["name","frame_base"],["value","18446743801062787672"]]]],["file","modules/axtask/src/task.rs"],["fullname","/home/oslab/Starry/modules/axtask/src/task.rs"],["line","746"],["arch","riscv:rv64"]]],["thread-id","1"],["stopped-threads","all"]]}]}
	 */
	protected stopEvent(info: MINode) {
		this.updateCurrentAddrAtStop(info);
		if (!this.started) this.crashed = true;
		if (!this.quit) {
			if(this.steppingStatus.isStepping){
				if(this.privilegeLevelJustChanged){
					this.stopStepping();
				}else{
					this.miDebugger.sendCliCommand('si');
					return;
				}
			}
			const event = new StoppedEvent("exception", parseInt(info.record("thread-id")));
			(event as DebugProtocol.StoppedEvent).body.allThreadsStopped =
				info.record("stopped-threads") == "all";
			this.sendEvent(event);
		}
	}
	public stopStepping() {
		this.steppingStatus={isStepping:false,steppingTo:null};
		this.sendEvent({
			event: "kernelSingleSteppedToUser",
			body: {},
		} as DebugProtocol.Event);
	}

	protected threadCreatedEvent(info: MINode) {
		this.sendEvent(new ThreadEvent("started", info.record("id")));
	}

	protected threadExitedEvent(info: MINode) {
		this.sendEvent(new ThreadEvent("exited", info.record("id")));
	}

	protected quitEvent() {
		this.quit = true;
		this.sendEvent(new TerminatedEvent());

		if (this.serverPath)
			fs.unlink(this.serverPath, (err) => {
				// eslint-disable-next-line no-console
				console.error("Failed to unlink debug server");
			});
	}

	protected launchError(err: any) {
		this.handleMsg(
			"stderr",
			"Could not start debugger process, does the program exist in filesystem?\n"
		);
		this.handleMsg("stderr", err.toString() + "\n");
		this.quitEvent();
	}

	protected override disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		if (this.attached)
			this.miDebugger.detach();
		else
			this.miDebugger.stop();
		this.commandServer.close();
		this.commandServer = undefined;
		this.sendResponse(response);
	}

	protected override async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
		try {
			if (this.useVarObjects) {
				let name = args.name;
				const parent = this.variableHandles.get(args.variablesReference);
				if (parent instanceof VariableScope) {
					name = VariableScope.variableName(args.variablesReference, name);
				} else if (parent instanceof VariableObject) {
					name = `${parent.name}.${name}`;
				}

				const res = await this.miDebugger.varAssign(name, args.value);
				response.body = {
					value: res.result("value"),
				};
			} else {
				await this.miDebugger.changeVariable(args.name, args.value);
				response.body = {
					value: args.value,
				};
			}
			this.sendResponse(response);
		} catch (err) {
			this.sendErrorResponse(response, 11, `Could not continue: ${err}`);
		}
	}

	protected override setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): void {
		const all: Thenable<[boolean, Breakpoint]>[] = [];
		args.breakpoints.forEach(brk => {
			all.push(this.miDebugger.addBreakPoint({ raw: brk.name, condition: brk.condition, countCondition: brk.hitCondition }));
		});
		Promise.all(all).then(brkpoints => {
			const finalBrks: DebugProtocol.Breakpoint[] = [];
			brkpoints.forEach(brkp => {
				if (brkp[0])
					finalBrks.push({ line: brkp[1].line, verified: true });
			});
			response.body = {
				breakpoints: finalBrks
			};
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 10, msg.toString());
		});
	}
	/// 用于设置某一个文件的所有断点
	protected override setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		let path = args.source.path;
		if (this.isSSH) {
			// convert local path to ssh path
			path = this.sourceFileMap.toRemotePath(path);
		}
		this.miDebugger.clearBreakPoints(path).then(() => {
			let spaceName = "";
			if(isKernelPath(path)){
				spaceName = "kernel";
			}else{
				spaceName = path;
			}
			//清空该文件的断点
			//保存断点信息，如果这个断点不是当前空间的（比如还在内核态时就设置用户态的断点），暂时不通知GDB设置断点
			//如果这个断点是当前地址空间，或者是内核入口断点，那么就通知GDB立即设置断点
			if ((spaceName === this.addressSpaces.getCurrentSpaceName()) || (path === this.GO_TO_KERNEL_FILENAME && args.breakpoints[0].line === this.GO_TO_KERNEL_LINE)
			) {
				// TODO rules can be set by user
				this.addressSpaces.saveBreakpointsToSpace(args, spaceName);				}
			else {
				this.sendEvent({
					event: "showInformationMessage",
					body: "Breakpoints Not in Current Address Space. Saved",
				} as DebugProtocol.Event);
				this.addressSpaces.saveBreakpointsToSpace(args, spaceName);
				return;
			}
			const all = args.breakpoints.map(brk => {
				return this.miDebugger.addBreakPoint({ file: path, line: brk.line, condition: brk.condition, countCondition: brk.hitCondition });
			});
			//令GDB设置断点
			Promise.all(all).then(brkpoints => {
				const finalBrks: DebugProtocol.Breakpoint[] = [];
				brkpoints.forEach(brkp => {
					// TODO: Currently all breakpoints returned are marked as verified,
					// which leads to verified breakpoints on a broken lldb.
					if (brkp[0])
						finalBrks.push(new DebugAdapter.Breakpoint(true, brkp[1].line));
						});
						response.body = {
							breakpoints: finalBrks,
						};
						this.sendResponse(response);
					},
					(msg) => {
						this.sendErrorResponse(response, 9, msg.toString());
					}
				);
			},
			(msg) => {
				this.sendErrorResponse(response, 9, msg.toString());
			}
		);
		this.customRequest("update", {} as DebugAdapter.Response, {});
	}

	protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		if (!this.miDebugger) {
			this.sendResponse(response);
			return;
		}
		this.miDebugger.getThreads().then(threads => {
			response.body = {
				threads: []
			};
			for (const thread of threads) {
				const threadName = thread.name || thread.targetId || "<unnamed>";
				response.body.threads.push(new Thread(thread.id, thread.id + ":" + threadName));
			}
			this.sendResponse(response);
		}).catch((error: MIError) => {
			if (error.message === 'Selected thread is running.') {
				this.sendResponse(response);
				return;
			}
			this.sendErrorResponse(response, 17, `Could not get threads: ${error}`);
		});
	}

	// Supports 65535 threads.
	protected threadAndLevelToFrameId(threadId: number, level: number) {
		return (level << 16) | threadId;
	}
	protected frameIdToThreadAndLevel(frameId: number) {
		return [frameId & 0xffff, frameId >> 16];
	}

	protected override stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		this.miDebugger.getStack(args.startFrame, args.levels, args.threadId).then(stack => {
			const ret: StackFrame[] = [];
			stack.forEach(element => {
				let source = undefined;
				let path = element.file;
				if (path) {
					if (this.isSSH) {
						// convert ssh path to local path
						path = this.sourceFileMap.toLocalPath(path);
					} else if (process.platform === "win32") {
						if (path.startsWith("\\cygdrive\\") || path.startsWith("/cygdrive/")) {
							path = path[10] + ":" + path.substring(11); // replaces /cygdrive/c/foo/bar.txt with c:/foo/bar.txt
						}
					}
					source = new Source(element.fileName, path);
				}

				ret.push(new StackFrame(
					this.threadAndLevelToFrameId(args.threadId, element.level),
					element.function + "@" + element.address,
					source,
					element.line,
					0));
			});
			response.body = {
				stackFrames: ret
			};
			this.sendResponse(response);
		}, err => {
			this.sendErrorResponse(response, 12, `Failed to get Stack Trace: ${err.toString()}`);
		});
	}

	protected override configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		const promises: Thenable<any>[] = [];
		let entryPoint: string | undefined = undefined;
		let runToStart: boolean = false;
		// Setup temporary breakpoint for the entry point if needed.
		switch (this.initialRunCommand) {
			case RunCommand.CONTINUE:
			case RunCommand.NONE:
				if (typeof this.stopAtEntry == "boolean" && this.stopAtEntry)
					entryPoint = "main"; // sensible default
				else if (typeof this.stopAtEntry == "string") entryPoint = this.stopAtEntry;
				break;
			case RunCommand.RUN:
				if (typeof this.stopAtEntry == "boolean" && this.stopAtEntry) {
					if (this.miDebugger.features.includes("exec-run-start-option")) runToStart = true;
					else entryPoint = "main"; // sensible fallback
				} else if (typeof this.stopAtEntry == "string") entryPoint = this.stopAtEntry;
				break;
			default:
				throw new Error("Unhandled run command: " + RunCommand[this.initialRunCommand]);
		}
		if (entryPoint) promises.push(this.miDebugger.setEntryBreakPoint(entryPoint));
		switch (this.initialRunCommand) {
			case RunCommand.CONTINUE:
				promises.push(
					this.miDebugger.continue().then(() => {
						// Some debuggers will provide an out-of-band status that they are stopped
						// when attaching (e.g., gdb), so the client assumes we are stopped and gets
						// confused if we start running again on our own.
						//
						// If we don't send this event, the client may start requesting data (such as
						// stack frames, local variables, etc.) since they believe the target is
						// stopped.  Furthermore, the client may not be indicating the proper status
						// to the user (may indicate stopped when the target is actually running).
						this.sendEvent(new ContinuedEvent(1, true));
					})
				);
				break;
			case RunCommand.RUN:
				promises.push(
					this.miDebugger.start(runToStart).then(() => {
						this.started = true;
						if (this.crashed) this.handlePause(undefined);
					})
				);
				break;
			case RunCommand.NONE: {
				// Not all debuggers seem to provide an out-of-band status that they are stopped
				// when attaching (e.g., lldb), so the client assumes we are running and gets
				// confused when we don't actually run or continue.  Therefore, we'll force a
				// stopped event to be sent to the client (just in case) to synchronize the state.
				const event: DebugProtocol.StoppedEvent = new StoppedEvent("pause", 1);
				event.body.description = "paused on attach";
				event.body.allThreadsStopped = true;
				this.sendEvent(event);
				break;
			}
			default:
				throw new Error("Unhandled run command: " + RunCommand[this.initialRunCommand]);
		}
		Promise.all(promises)
			.then(() => {
				this.sendResponse(response);
			})
			.catch((err) => {
				this.sendErrorResponse(response, 18, `Could not run/continue: ${err.toString()}`);
			});
	}

	protected override scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		const scopes = new Array<Scope>();
		const [threadId, level] = this.frameIdToThreadAndLevel(args.frameId);

		const createScope = (scopeName: string, expensive: boolean): Scope => {
			const key: string = scopeName + ":" + threadId + ":" + level;
			let handle: number;

			if (this.scopeHandlesReverse.hasOwnProperty(key)) {
				handle = this.scopeHandlesReverse[key];
			} else {
				handle = this.variableHandles.create(new VariableScope(scopeName, threadId, level));
				this.scopeHandlesReverse[key] = handle;
			}

			return new Scope(scopeName, handle, expensive);
		};

		scopes.push(createScope("Locals", false));
		scopes.push(createScope("Registers", true));

		response.body = {
			scopes: scopes,
		};
		this.sendResponse(response);
	}

	protected override async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
		const variables: DebugProtocol.Variable[] = [];
		const id: VariableScope | string | VariableObject | ExtendedVariable = this.variableHandles.get(args.variablesReference);

		const createVariable = (arg: string | VariableObject, options?: any) => {
			if (options)
				return this.variableHandles.create(new ExtendedVariable(typeof arg === 'string' ? arg : arg.name, options));
			else
				return this.variableHandles.create(arg);
		};

		const findOrCreateVariable = (varObj: VariableObject): number => {
			let id: number;
			if (this.variableHandlesReverse.hasOwnProperty(varObj.name)) {
				id = this.variableHandlesReverse[varObj.name];
			} else {
				id = createVariable(varObj);
				this.variableHandlesReverse[varObj.name] = id;
			}
			return varObj.isCompound() ? id : 0;
		};

		if (id instanceof VariableScope) {
			try {
				if (id.name == "Registers") {
					const registers = await this.miDebugger.getRegisters();
					for (const reg of registers) {
						variables.push({
							name: reg.name,
							value: reg.valueStr,
							variablesReference: 0
						});
					}
				} else {
					const stack: Variable[] = await this.miDebugger.getStackVariables(id.threadId, id.level);
					for (const variable of stack) {
						if (this.useVarObjects) {
							try {
								const varObjName = VariableScope.variableName(args.variablesReference, variable.name);
								let varObj: VariableObject;
								try {
									const changes = await this.miDebugger.varUpdate(varObjName);
									const changelist = changes.result("changelist");
									changelist.forEach((change: any) => {
										const name = MINode.valueOf(change, "name");
										const vId = this.variableHandlesReverse[name];
										const v = this.variableHandles.get(vId) as any;
										v.applyChanges(change);
									});
									const varId = this.variableHandlesReverse[varObjName];
									varObj = this.variableHandles.get(varId) as any;
								} catch (err) {
									if (err instanceof MIError && (err.message == "Variable object not found" || err.message.endsWith("does not exist"))) {
										varObj = await this.miDebugger.varCreate(id.threadId, id.level, variable.name, varObjName);
										const varId = findOrCreateVariable(varObj);
										varObj.exp = variable.name;
										varObj.id = varId;
									} else {
										throw err;
									}
								}
								variables.push(varObj.toProtocolVariable());
							} catch (err) {
								variables.push({
									name: variable.name,
									value: `<${err}>`,
									variablesReference: 0
								});
							}
						} else {
							if (variable.valueStr !== undefined) {
								let expanded = expandValue(createVariable, `{${variable.name}=${variable.valueStr})`, "", variable.raw);
								if (expanded) {
									if (typeof expanded[0] == "string")
										expanded = [
											{
												name: "<value>",
												value: prettyStringArray(expanded),
												variablesReference: 0
											}
										];
									variables.push(expanded[0]);
								}
							} else
								variables.push({
									name: variable.name,
									type: variable.type,
									value: "<unknown>",
									variablesReference: createVariable(variable.name)
								});
						}
					}
				}
				response.body = {
					variables: variables
				};
				this.sendResponse(response);
			} catch (err) {
				this.sendErrorResponse(response, 1, `Could not expand variable: ${err}`);
			}
		} else if (typeof id == "string") {
			// Variable members
			let variable;
			try {
				// TODO: this evaluates on an (effectively) unknown thread for multithreaded programs.
				variable = await this.miDebugger.evalExpression(JSON.stringify(id), 0, 0);
				try {
					let expanded = expandValue(createVariable, variable.result("value"), id, variable);
					if (!expanded) {
						this.sendErrorResponse(response, 2, `Could not expand variable`);
					} else {
						if (typeof expanded[0] == "string")
							expanded = [
								{
									name: "<value>",
									value: prettyStringArray(expanded),
									variablesReference: 0
								}
							];
						response.body = {
							variables: expanded
						};
						this.sendResponse(response);
					}
				} catch (e) {
					this.sendErrorResponse(response, 2, `Could not expand variable: ${e}`);
				}
			} catch (err) {
				this.sendErrorResponse(response, 1, `Could not expand variable: ${err}`);
			}
		} else if (typeof id == "object") {
			if (id instanceof VariableObject) {
				// Variable members
				let children: VariableObject[];
				try {
					children = await this.miDebugger.varListChildren(id.name);
					const vars = children.map(child => {
						const varId = findOrCreateVariable(child);
						child.id = varId;
						return child.toProtocolVariable();
					});

					response.body = {
						variables: vars
					};
					this.sendResponse(response);
				} catch (err) {
					this.sendErrorResponse(response, 1, `Could not expand variable: ${err}`);
				}
			} else if (id instanceof ExtendedVariable) {
				const varReq = id;
				if (varReq.options.arg) {
					const strArr: DebugProtocol.Variable[] = [];
					let argsPart = true;
					let arrIndex = 0;
					const submit = () => {
						response.body = {
							variables: strArr
						};
						this.sendResponse(response);
					};
					const addOne = async () => {
						// TODO: this evaluates on an (effectively) unknown thread for multithreaded programs.
						const variable = await this.miDebugger.evalExpression(JSON.stringify(`${varReq.name}+${arrIndex})`), 0, 0);
						try {
							const expanded = expandValue(createVariable, variable.result("value"), varReq.name, variable);
							if (!expanded) {
								this.sendErrorResponse(response, 15, `Could not expand variable`);
							} else {
								if (typeof expanded == "string") {
									if (expanded == "<nullptr>") {
										if (argsPart)
											argsPart = false;
										else
											return submit();
									} else if (expanded[0] != '"') {
										strArr.push({
											name: "[err]",
											value: expanded,
											variablesReference: 0
										});
										return submit();
									}
									strArr.push({
										name: `[${(arrIndex++)}]`,
										value: expanded,
										variablesReference: 0
									});
									addOne();
								} else {
									strArr.push({
										name: "[err]",
										value: expanded,
										variablesReference: 0
									});
									submit();
								}
							}
						} catch (e) {
							this.sendErrorResponse(response, 14, `Could not expand variable: ${e}`);
						}
					};
					addOne();
				} else
					this.sendErrorResponse(response, 13, `Unimplemented variable request options: ${JSON.stringify(varReq.options)}`);
			} else {
				response.body = {
					variables: id
				};
				this.sendResponse(response);
			}
		} else {
			response.body = {
				variables: variables
			};
			this.sendResponse(response);
		}
	}

	protected override pauseRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.miDebugger.interrupt().then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 3, `Could not pause: ${msg}`);
		});
	}

	protected override reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
		this.miDebugger.continue(true).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 2, `Could not continue: ${msg}`);
		});
	}

	protected override continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.miDebugger.continue().then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 2, `Could not continue: ${msg}`);
		});
	}

	protected override stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this.miDebugger.step(true).then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 4, `Could not step back: ${msg} - Try running 'target record-full' before stepping back`);
		});
	}

	protected override stepInRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.miDebugger.step().then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 4, `Could not step in: ${msg}`);
		});
	}

	protected override stepOutRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.miDebugger.stepOut().then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 5, `Could not step out: ${msg}`);
		});
	}

	protected override nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.miDebugger.next().then(done => {
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 6, `Could not step over: ${msg}`);
		});
	}

	protected override evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		const [threadId, level] = this.frameIdToThreadAndLevel(args.frameId);
		if (args.context == "watch" || args.context == "hover") {
			this.miDebugger.evalExpression(args.expression, threadId, level).then(
				(res) => {
					response.body = {
						variablesReference: 0,
						result: res.result("value"),
					};
					this.sendResponse(response);
				},
				(msg) => {
					this.sendErrorResponse(response, 7, msg.toString());
				}
			);
		} else {
			this.miDebugger.sendUserInput(args.expression, threadId, level).then(
				(output) => {
					if (typeof output == "undefined")
						response.body = {
							result: "",
							variablesReference: 0,
						};
					else
						response.body = {
							result: JSON.stringify(output),
							variablesReference: 0,
						};
					this.sendResponse(response);
				},
				(msg) => {
					this.sendErrorResponse(response, 8, msg.toString());
				}
			);
		}
	}

	protected override gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments): void {
		const path: string = this.isSSH ? this.sourceFileMap.toRemotePath(args.source.path) : args.source.path;
		this.miDebugger.goto(path, args.line).then(done => {
			response.body = {
				targets: [{
					id: 1,
					label: args.source.name,
					column: args.column,
					line: args.line
				}]
			};
			this.sendResponse(response);
		}, msg => {
			this.sendErrorResponse(response, 16, `Could not jump: ${msg}`);
		});
	}

	protected override gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments): void {
		this.sendResponse(response);
	}

	protected setSourceFileMap(
		configMap: { [index: string]: string },
		fallbackGDB: string,
		fallbackIDE: string
	): void {
		if (configMap === undefined) {
			this.sourceFileMap = new SourceFileMap({ [fallbackGDB]: fallbackIDE });
		} else {
			this.sourceFileMap = new SourceFileMap(configMap, fallbackGDB);
		}
	}

	protected readMemoryRequest(
		response: DebugProtocol.ReadMemoryResponse,
		args: DebugProtocol.ReadMemoryArguments,
		request?: DebugProtocol.Request
	): void {
		if (args.count == 0) {
			// 不太清楚为啥会有0长度的读取命令，但这样的请求会使GDB返回错误。
			response.body = {
				address: "0x0",
				data: "",
			};
			this.sendResponse(response);
			return;
		}

		this.miDebugger.examineMemory(args.memoryReference, args.count).then(
			(data) => {
				console.log(data);

				const bytes = Buffer.alloc(data.contents.length / 2);
				for (let i = 0, c = 0; c < data.contents.length; c += 2, i += 1)
					bytes[i] = parseInt(data.contents.substr(c, 2), 16);

				const base64_data = bytes.toString("base64");

				response.body = {
					address: data.begin,
					data: base64_data,
				};
				this.sendResponse(response);
			},
			(err) => {
				this.sendEvent({ event: "showErrorMessage", body: err.toString() } as DebugProtocol.Event);
			}
		);
	}

	protected writeMemoryRequest(
		response: DebugProtocol.WriteMemoryResponse,
		args: DebugProtocol.WriteMemoryArguments,
		request?: DebugProtocol.Request
	): void {
		if (args.data.length == 0) {
			this.sendErrorResponse(response, 0);
			return;
		}

		const buff = Buffer.from(args.data, "base64");

		const hex = [];
		for (let i = 0; i < buff.length; i++) {
			const current = buff[i] < 0 ? buff[i] + 256 : buff[i];
			hex.push((current >>> 4).toString(16));
			hex.push((current & 0xf).toString(16));
		}
		const hex_to_backend = hex.join("");

		this.miDebugger
			.sendCommand("data-write-memory-bytes " + args.memoryReference + " " + hex_to_backend)
			.then(
				(result) => {
					this.sendResponse(response);
				},
				(err) => {
					this.sendErrorResponse(response, 0);
				}
			);
	}

	///返回消息可以用Event或者Response。用Response更规范，用Event代码更简单。
	protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {
		switch (command) {
			case "eventTest":
				this.sendEvent({ event: "eventTest", body: ["test"] } as DebugProtocol.Event);
				this.sendResponse(response);
				break;
			case "memValuesRequest":
				this.miDebugger.examineMemory(args.from, args.length).then((data) => {
					this.sendEvent({
						event: "memValues",
						body: { data: data, from: args.from, length: args.length },
					} as DebugProtocol.Event);
				});
				this.sendResponse(response);
				break;
			case "addDebugFile":
				this.miDebugger.sendCliCommand("add-symbol-file " + args.debugFilepath);
				break;
			case "removeDebugFile":
				this.miDebugger.sendCliCommand("remove-symbol-file " + args.debugFilepath);
				break;
			case "setKernelInBreakpoints": //remove previous breakpoints in this source
				this.setBreakPointsRequest(
					response as DebugProtocol.SetBreakpointsResponse,
					{
						source: { path: this.KERNEL_IN_BREAKPOINTS_FILENAME } as DebugProtocol.Source,
						breakpoints: [{ line: this.KERNEL_IN_BREAKPOINTS_LINE }] as DebugProtocol.SourceBreakpoint[], //TODO change this to GO_TO_KERNEL?
					} as DebugProtocol.SetBreakpointsArguments
				);
				break;
			case "setKernelOutBreakpoints": //remove previous breakpoints in this source
				this.setBreakPointsRequest(
					response as DebugProtocol.SetBreakpointsResponse,
					{
						source: { path: this.KERNEL_OUT_BREAKPOINTS_FILENAME } as DebugProtocol.Source,
						breakpoints: [{ line: this.KERNEL_OUT_BREAKPOINTS_LINE }] as DebugProtocol.SourceBreakpoint[],
					} as DebugProtocol.SetBreakpointsArguments
				);
				break;
			// case "setKernelOutBreakpoints": //out only
				// break;
			case "removeAllCliBreakpoints":
				this.addressSpaces.removeAllBreakpoints();
				this.miDebugger.sendCliCommand("del");
				this.customRequest("update", {} as DebugAdapter.Response, {});
				break;
			case "goToKernel":
				this.addressSpaces.disableCurrentSpaceBreakpoints();
				this.setBreakPointsRequest(
					response as DebugProtocol.SetBreakpointsResponse,
					{
						source: { path: this.GO_TO_KERNEL_FILENAME } as DebugProtocol.Source,
						breakpoints: [{ line: this.GO_TO_KERNEL_LINE }] as DebugProtocol.SourceBreakpoint[],
					} as DebugProtocol.SetBreakpointsArguments
				);
				//this.sendEvent({ event: "eventTest"} as DebugProtocol.Event);
				this.sendEvent({ event: "trap_handle" } as DebugProtocol.Event);
				break;
			// case "update":
			// 	this.sendEvent({
			// 		event: "update",
			// 		body: { data: this.addressSpaces.status() },
			// 	} as DebugProtocol.Event);
			// 	this.sendResponse(response);
			// 	break;
			case "updateCurrentSpace":
				this.addressSpaces.updateCurrentSpace(args);
				break;
			case "disableCurrentSpaceBreakpoints":
				this.addressSpaces.disableCurrentSpaceBreakpoints();
				break;
			case 'send_gdb_cli_command':
				this.miDebugger.sendCliCommand(args);
				break;
			case 'send_gdb_mi_command':
				this.miDebugger.sendCommand(args);
				break;
			case 'getStringFromAddr':
				this.miDebugger.sendCliCommand("x /s "+args).then((result)=>{
					// let quotation_regex = /"(.*?)"/;
					// let info=this.miDebugger.getMIinfo(result.token);
					// this.sendEvent({ event: "printThisInConsole", body: info  } as DebugProtocol.Event);
				});
				break;
			case 'kernelSingleSteppingToUser'://this is so fucking stupid
				this.steppingStatus={isStepping:true,steppingTo:privilegeLevel.user};
				this.miDebugger.sendCommand('si');
				break;
			default:
				return this.sendResponse(response);
		}
	}


	public sendDebugSessionEvent(anything: any) {
		this.sendEvent(anything);
	}

	public addr2privilege(addr64: number):privilegeLevel {
		for(let i = 0;i<this.kernel_memory_ranges.length;i++){//[a,b) 左闭右开
			if(Number(this.kernel_memory_ranges[i][0])<=addr64 && addr64<Number(this.kernel_memory_ranges[i][1])){
				return privilegeLevel.kernel;
			}
		}
		for(let i = 0;i<this.user_memory_ranges.length;i++){
			if(Number(this.user_memory_ranges[i][0])<=addr64 && addr64 <Number(this.user_memory_ranges[i][1])){
				return privilegeLevel.user;
			}
		}
		return privilegeLevel.unknown;
	}
}



// function findAddr(info:MINode){
// 	for(let i in info){
// 		if(info[i]){
			
// 		}
// 	}
// }

function prettyStringArray(strings: any) {
	if (typeof strings == "object") {
		if (strings.length !== undefined) return strings.join(", ");
		else return JSON.stringify(strings);
	} else return strings;
}
