/** SID-based Windows security inspection and write-through replacement, without localized account names. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Injectable PowerShell execution; output contains security metadata, never file contents. */
export type WindowsPrivateFilesExecutor = (script: string) => Promise<string>

const executeFile = promisify(execFile)
/** Execute a bounded, noninteractive Windows security operation.
 * @param script - Internally generated PowerShell source with encoded literal paths.
 * @returns Standard output containing only the operation result.
 */
export const executeWindowsPrivateFiles: WindowsPrivateFilesExecutor = async (script) => {
  try {
    const result = await executeFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(`$ErrorActionPreference = 'Stop'; ${script}`, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
    return result.stdout.trim()
  } catch (error) { void error; throw new Error('Windows private security operation unavailable') }
}

function literal(path: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(path).toString('base64')}'))`
}

/** Inspect target and optional private directory ACLs with one complete ancestor traversal.
 * @param path - Absolute target path.
 * @param directory - Private directory containing the target, when checking a file.
 * @returns One metadata-only JSON object; ACL identities are emitted as SIDs.
 */
export function inspectWindowsPrivatePath(path: string, directory?: string): string {
  return `$p = ${literal(path)};
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User;
$reparse = $false; $parents = $true; $cursor = $p;
while ($null -ne $cursor) {
  $attributes = [IO.File]::GetAttributes($cursor);
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $reparse = $true; break }
  if ($cursor -ne $p -and ($attributes -band [IO.FileAttributes]::Directory) -eq 0) { $parents = $false }
  $parent = [IO.Directory]::GetParent($cursor);
  if ($null -eq $parent) { $cursor = $null } else { $cursor = $parent.FullName }
}
if ($reparse) { @{ reparse = $true } | ConvertTo-Json -Compress; exit }
function Read-PrivateAcl([string]$target) {
  $acl = Get-Acl -LiteralPath $target;
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; allow = ($_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow);
       rights = [int]$_.FileSystemRights; propagation = [int]$_.PropagationFlags }
  });
  return @{ reparse = $false; parents = $parents; sid = $sid.Value; owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
     protected = $acl.AreAccessRulesProtected; rules = $rules }
}
$result = Read-PrivateAcl $p;
${directory === undefined ? '' : `$result.directory = Read-PrivateAcl (${literal(directory)});`}
$result | ConvertTo-Json -Depth 5 -Compress`
}

/** Generate an owner-only DACL for a newly created empty object; never use on existing data.
 * @param path - Exclusively created empty file or directory.
 * @param directory - Whether the new object is a directory.
 * @returns PowerShell source that replaces inherited rules before any content is written.
 */
export function secureWindowsPrivatePath(path: string, directory: boolean): string {
  return `$p = ${literal(path)};
if (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private reparse point rejected' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl = New-Object Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'};
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false);
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow);
$acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`
}

/** Generate a same-volume replacement that waits for Windows to flush the move.
 * @param source - Secured and flushed temporary file.
 * @param target - Checked destination in the same directory.
 * @returns PowerShell source returning a numeric Win32 error, zero on success.
 */
export function replaceWindowsPrivatePath(source: string, target: string): string {
  return `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PrivateFileMove {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool MoveFileExW(string source, string target, uint flags);
}
'@;
if ([PrivateFileMove]::MoveFileExW(${literal(source)}, ${literal(target)}, 9)) { '0' }
else { [Runtime.InteropServices.Marshal]::GetLastWin32Error().ToString() }`
}
