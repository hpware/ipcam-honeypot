// Virtual camera shell (DCS-2130 firmware 1.23.00, busybox 1.19.4).
// Shared by the telnet listener and the rtpd.cgi / docmd.htm HTTP handlers —
// attacker commands are matched against a static table, never executed.

export interface VshCtx {
  cwd: string;
  note: (t: string) => void;
}

const ROOT_DIRS = ["bin", "dev", "etc", "home", "lib", "mnt", "proc", "sbin", "sys", "tmp", "usr", "var", "www"];
export const BIN = [
  "busybox", "cat", "chmod", "chown", "cp", "date", "dd", "df", "echo", "grep", "gunzip", "gzip",
  "kill", "ln", "ls", "mkdir", "mknod", "more", "mount", "mv", "netstat", "ping", "ps", "pwd",
  "rm", "rmdir", "sed", "sh", "sleep", "sync", "tar", "touch", "umount", "uname", "vi",
];
const SBIN = ["dnrd", "eventd", "ifconfig", "init", "insmod", "iptables", "reboot", "rmmod", "route", "upnpd"];
const WWW = ["index.html", "live.html", "snapshot.html", "setup", "images", "js"];

export const KERNEL = "2.6.31.8";
const KERNEL_BUILD = "#1 PREEMPT Tue Oct 20 15:37:05 CST 2015";

const FILES: Record<string, string> = {
  "/etc/passwd": "root:x:0:0:root:/root:/bin/sh\nbin:x:1:1:bin:/bin:/bin/sh\nnobody:x:99:99:nobody:/home:/bin/sh\n",
  "/proc/version": `Linux version ${KERNEL} (dlink@localhost) (gcc version 4.4.5-1.5.5p1 (Sourcery G++ Lite 2010.09-50)) ${KERNEL_BUILD}\n`,
  "/proc/cpuinfo":
    "processor       : 0\nmodel name      : ARM926EJ-S rev 5 (v5l)\nBogoMIPS        : 226.09\nFeatures        : swp half thumb fastmult vfp edsp\ncpu implementer : 0x41\ncpu architecture: 5TEJ\ncache type      : write-back\ncache clean     : cp15 c7 ops\ncache lockdown  : format C\ncache format    : Harvard\nHardware        : BOCK-W\nRevision        : 0000\nSerial          : 0000000000000000\n",
  "/proc/uptime": "4061520.32 3982455.10\n",
  "/etc/fstab": "/dev/root on / type jffs2 (rw)\nproc on /proc type proc (rw)\nsysfs on /sys type sysfs (rw)\ntmpfs on /tmp type tmpfs (rw,size=14750k)\n",
  "/etc/boa.conf":
    "Port 80\nUser nobody\nGroup nobody\nErrorLog /var/log/boa/error_log\nAccessLog /var/log/boa/access_log\nDocumentRoot /www\nDirectoryIndex index.html\nScriptAlias /cgi-bin/ /www/cgi-bin/\nMimeTypes /etc/mime.types\nDefaultType text/plain\n",
  "/etc/resolv.conf": "nameserver 192.168.0.1\n",
};

function lsDir(path: string): string | null {
  const p = path === "" ? "/" : path;
  if (p === "/" || p === "") return ROOT_DIRS.join("  ");
  if (p === "/bin") return BIN.join("  ");
  if (p === "/sbin") return SBIN.join("  ");
  if (p === "/www") return WWW.join("  ");
  if (p === "/etc") return "boa.conf  fstab  group  hosts  inittab  mime.types  passwd  resolv.conf  services  shadow";
  if (p === "/dev") return "console  null  ttyS0  urandom  zero";
  if (p === "/home" || p === "/mnt" || p === "/var") return "";
  if (p === "/root") return "";
  if (p === "/usr") return "bin  lib  sbin  share";
  if (p === "/tmp") return ".dlink_cache";
  if (p === "/proc") return "1  88  cpuinfo  mounts  uptime  version  net";
  return null;
}

function abspath(cwd: string, arg: string | undefined): string {
  if (arg === undefined || arg === "" || arg === "~") arg = cwd === "" ? "/" : cwd;
  let p = arg;
  if (!p.startsWith("/")) p = (cwd === "/" ? "" : cwd) + "/" + p;
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export function banner(): string {
  return "\nBusyBox v1.19.4 () built-in shell (ash)\nEnter 'help' for a list of built-in commands.\n\n";
}

export function execCommand(line: string, ctx: VshCtx): { out: string; close?: boolean } {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0]!;
  const args = parts.slice(1);
  const arg0 = args[0];

  switch (cmd) {
    case "ls": {
      const target = abspath(ctx.cwd, args.find((a) => !a.startsWith("-")));
      if (target === "/etc/shadow" || target === "/etc/shadow/") return { out: `ls: ${target}: Permission denied` };
      const listing = lsDir(target);
      if (listing === null) return { out: `ls: ${target}: No such file or directory` };
      if (args.some((a) => a.startsWith("-") && a.includes("l"))) {
        const body = listing
          ? listing.split("  ").filter(Boolean)
              .map((n) => `drwxr-xr-x    2 root     root            0 Oct 20  2015 ${n}`)
              .join("\n") + "\n"
          : "";
        return { out: `total 0\n${body}` };
      }
      return { out: listing };
    }
    case "pwd":
      return { out: ctx.cwd };
    case "cd": {
      const target = abspath(ctx.cwd, args[0] ?? "/root");
      if (lsDir(target) === null && !FILES[target]) return { out: `sh: cd: ${target}: No such file or directory` };
      ctx.cwd = target;
      return { out: "" };
    }
    case "cat":
    case "more": {
      const target = abspath(ctx.cwd, arg0);
      if (target === "/etc/shadow") return { out: `cat: can't open '${target}': Permission denied` };
      const file = FILES[target];
      if (file !== undefined) return { out: file.replace(/\n$/, "") };
      if (lsDir(target) !== null) return { out: `cat: read error: Is a directory` };
      return { out: `cat: can't open '${target}': No such file or directory` };
    }
    case "uname":
      if (args.some((a) => a === "-a"))
        return { out: `Linux DCS-2130 ${KERNEL} ${KERNEL_BUILD} armv5tejl GNU/Linux` };
      if (args.some((a) => a === "-r")) return { out: KERNEL };
      return { out: "Linux" };
    case "busybox":
      if (!arg0 || arg0 === "--help" || arg0 === "-h") {
        return {
          out: `BusyBox v1.19.4 () multi-call binary.\n\nUsage: busybox [function] [arguments]...\n\nCurrently defined functions:\n${BIN.filter((b) => b !== "busybox").join(", ")}\n`,
        };
      }
      return { out: `busybox: applet not found` };
    case "id":
      return { out: "uid=0(root) gid=0(root)" };
    case "whoami":
      return { out: "root" };
    case "hostname":
      return { out: "DCS-2130" };
    case "ps":
      return {
        out:
          "  PID USER     TIME  COMMAND\n" +
          "    1 root       0:01 init\n" +
          "    2 root       0:00 [kthreadd]\n" +
          "    3 root       0:00 [ksoftirqd/0]\n" +
          "   25 root       0:00 [mtdblock3]\n" +
          "   41 root       0:00 [jffs2_gcd_mtd3]\n" +
          "   88 root       0:02 /bin/boa\n" +
          "   91 root       0:01 /sbin/rtspd\n" +
          "   96 root       0:00 /sbin/dnrd -a 192.168.0.20\n" +
          "  100 root       0:00 /sbin/eventd\n" +
          "  103 root       0:00 /sbin/telnetd\n" +
          "  112 root       0:00 -sh\n" +
          `  ${130 + (Math.floor(Math.random() * 50))} root       0:00 ps`,
      };
    case "ifconfig":
      return {
        out:
          "eth0      Link encap:Ethernet  HWaddr 00:1C:F0:AA:BB:CC\n" +
          "          inet addr:192.168.0.20  Bcast:192.168.0.255  Mask:255.255.255.0\n" +
          "          UP BROADCAST RUNNING MULTICAST  MTU:1500  Metric:1\n" +
          "          RX packets:847261 errors:0 dropped:0 overruns:0 frame:0\n" +
          "          TX packets:512309 errors:0 dropped:0 overruns:0 carrier:0\n" +
          "          collisions:0 txqueuelen:1000\n" +
          "          RX bytes:98234102 (93.6 MiB)  TX bytes:64123855 (61.1 MiB)\n" +
          "          Interrupt:37 Base address:0xc000\n\n" +
          "lo        Link encap:Local Loopback\n" +
          "          inet addr:127.0.0.1  Mask:255.0.0.0\n" +
          "          UP LOOPBACK RUNNING  MTU:16436  Metric:1\n" +
          "          RX packets:1245 errors:0 dropped:0 overruns:0 frame:0\n" +
          "          TX packets:1245 errors:0 dropped:0 overruns:0 carrier:0\n" +
          "          collisions:0 txqueuelen:0\n" +
          "          RX bytes:98765 (96.4 KiB)  TX bytes:98765 (96.4 KiB)\n",
      };
    case "netstat":
      return {
        out:
          "Active Internet connections (w/o servers)\n" +
          "Proto Recv-Q Send-Q Local Address           Foreign Address         State\n" +
          "tcp        0      0 192.168.0.20:80         0.0.0.0:*               LISTEN\n" +
          "tcp        0      0 192.168.0.20:554        0.0.0.0:*               LISTEN\n" +
          "tcp        0      0 0.0.0.0:23              0.0.0.0:*               LISTEN\n" +
          "tcp        0      0 192.168.0.20:80         10.0.0.5:49512          ESTABLISHED\n",
      };
    case "free":
      return {
        out:
          "              total         used         free       shared      buffers\n" +
          "Mem:        29500        21340         8160            0         1240\n" +
          "Swap:            0            0            0\n",
      };
    case "df":
      return {
        out:
          "Filesystem           1K-blocks      Used Available Use% Mounted on\n" +
          "/dev/root                4863      4863         0 100% /\n" +
          "tmpfs                   14750       100     14650   1% /tmp\n",
      };
    case "mount":
      return { out: FILES["/etc/fstab"]!.replace(/\n$/, "") };
    case "uptime":
      return { out: " 21:37:05 up 47 days,  3:12, load average: 0.08, 0.03, 0.05" };
    case "date": {
      const d = new Date();
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const mons = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const p = (n: number) => String(n).padStart(2, "0");
      return {
        out: `${days[d.getUTCDay()]} ${mons[d.getUTCMonth()]} ${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`,
      };
    }
    case "echo":
      return { out: args.join(" ") };
    case "ping": {
      if (!arg0) return { out: "ping: missing host" };
      ctx.note(`ping target: ${arg0}`);
      return {
        out: `PING ${arg0} (${arg0}): 56 data bytes\n\n--- ${arg0} ping statistics ---\n4 packets transmitted, 0 packets received, 100% packet loss\n`,
      };
    }
    case "wget":
    case "tftp": {
      ctx.note(`${cmd} fetch attempt: ${args.join(" ")}`);
      return { out: `wget: bad address '${arg0 ?? ""}'` };
    }
    case "rm":
    case "mv":
    case "cp":
    case "mkdir":
    case "rmdir":
    case "touch": {
      const target = abspath(ctx.cwd, arg0);
      if (target.startsWith("/tmp")) return { out: "" };
      return { out: `${cmd}: can't create '${target}': Read-only file system` };
    }
    case "reboot":
    case "poweroff":
    case "shutdown":
    case "halt":
      ctx.note(`${cmd} attempt`);
      return { out: "", close: true };
    case "exit":
    case "quit":
    case "logout":
      return { out: "", close: true };
    case "sh":
    case "shell":
      return { out: "" };
    case "help":
      return {
        out:
          "Built-in commands:\n-------------------\n\t. : [ [[ alias bg break cd chdir command continue echo eval exec exit\n\texport false fg getopts hash help jobs kill let local printf pwd read\n\treturn set shift source test times trap true type ulimit umask unalias\n\tunset wait",
      };
    default:
      return { out: `sh: ${cmd}: not found` };
  }
}

/** Run a full command line (may contain `;` chains), returning joined output. */
export function runCommandLine(line: string, ctx: VshCtx): string {
  const out: string[] = [];
  for (const part of line.split(";")) {
    const cmd = part.trim();
    if (!cmd) continue;
    try {
      const r = execCommand(cmd, ctx);
      if (r.out) out.push(r.out);
    } catch {
      out.push("sh: syntax error");
    }
  }
  return out.join("\n");
}
