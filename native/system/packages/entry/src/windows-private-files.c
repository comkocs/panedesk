/* Stable Node-API Win32 private-file metadata, owner-only DACLs and write-through moves. */
#include <node_api.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static napi_value fail(napi_env env) {
  napi_throw_error(env, "ERR_WINDOWS_PRIVATE_FILES", "Windows private security operation unavailable");
  return NULL;
}
static int property(napi_env env, napi_value object, const char *name, napi_value value) {
  return napi_set_named_property(env, object, name, value) == napi_ok;
}
static int boolean(napi_env env, napi_value object, const char *name, int value) {
  napi_value result;
  return napi_get_boolean(env, value != 0, &result) == napi_ok && property(env, object, name, result);
}
static int number(napi_env env, napi_value object, const char *name, DWORD value) {
  napi_value result;
  return napi_create_uint32(env, value, &result) == napi_ok && property(env, object, name, result);
}
static int sid_value(napi_env env, napi_value object, const char *name, PSID sid) {
  LPWSTR text = NULL;
  napi_value result;
  if (!IsValidSid(sid) || !ConvertSidToStringSidW(sid, &text)) return 0;
  int ok = napi_create_string_utf16(env, (const char16_t *)text, wcslen(text), &result) == napi_ok
    && property(env, object, name, result);
  LocalFree(text);
  return ok;
}
static wchar_t *path_argument(napi_env env, napi_value value) {
  size_t size;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &size) != napi_ok) return NULL;
  wchar_t *path = calloc(size + 1, sizeof(wchar_t));
  if (path == NULL) return NULL;
  size_t written;
  if (napi_get_value_string_utf16(env, value, (char16_t *)path, size + 1, &written) != napi_ok
      || written != size || wcslen(path) != size || size < 3
      || !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))
      || path[1] != L':' || path[2] != L'\\' || wcschr(path, L'/') != NULL) {
    free(path); return NULL;
  }
  return path;
}
static TOKEN_USER *current_user(void) {
  HANDLE token;
  DWORD size = 0;
  /* WindowsIdentity.GetCurrent uses an impersonation token when one is present. */
  if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token)) {
    if (GetLastError() != ERROR_NO_TOKEN || !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return NULL;
  }
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  TOKEN_USER *user = malloc(size);
  if (user == NULL || !GetTokenInformation(token, TokenUser, user, size, &size)) {
    free(user); user = NULL;
  }
  CloseHandle(token);
  return user;
}
static int ancestors(wchar_t *path, int *reparse, int *parents) {
  size_t length = wcslen(path);
  wchar_t *cursor = malloc((length + 1) * sizeof(wchar_t));
  if (cursor == NULL) return 0;
  memcpy(cursor, path, (length + 1) * sizeof(wchar_t));
  *reparse = 0; *parents = 1;
  int target = 1;
  for (;;) {
    DWORD attributes = GetFileAttributesW(cursor);
    if (attributes == INVALID_FILE_ATTRIBUTES) { free(cursor); return 0; }
    if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) { *reparse = 1; break; }
    if (!target && !(attributes & FILE_ATTRIBUTE_DIRECTORY)) *parents = 0;
    if (wcslen(cursor) <= 3) break;
    wchar_t *slash = wcsrchr(cursor, L'\\');
    if (slash == NULL) { free(cursor); return 0; }
    if (slash == cursor + 2) cursor[3] = L'\0'; else *slash = L'\0';
    target = 0;
  }
  free(cursor);
  return 1;
}
static int read_acl(napi_env env, wchar_t *path, PSID user, int parents, napi_value *result) {
  PSID owner = NULL;
  PACL acl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (GetNamedSecurityInfoW(path, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, NULL, &acl, NULL, &descriptor) != ERROR_SUCCESS) return 0;
  SECURITY_DESCRIPTOR_CONTROL control;
  DWORD revision;
  napi_value rules;
  int ok = acl != NULL && IsValidAcl(acl)
    && GetSecurityDescriptorControl(descriptor, &control, &revision)
    && napi_create_object(env, result) == napi_ok
    && boolean(env, *result, "reparse", 0) && boolean(env, *result, "parents", parents)
    && sid_value(env, *result, "sid", user) && sid_value(env, *result, "owner", owner)
    && boolean(env, *result, "protected", control & SE_DACL_PROTECTED)
    && napi_create_array_with_length(env, acl->AceCount, &rules) == napi_ok;
  for (DWORD i = 0; ok && i < acl->AceCount; i++) {
    void *raw = NULL;
    if (!GetAce(acl, i, &raw)) { ok = 0; break; }
    ACE_HEADER *header = raw;
    if ((header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE)
        || header->AceSize < sizeof(ACCESS_ALLOWED_ACE)) { ok = 0; break; }
    ACCESS_ALLOWED_ACE *ace = raw;
    PSID sid = &ace->SidStart;
    DWORD sid_space = (DWORD)header->AceSize - (DWORD)FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart);
    if (sid_space < GetSidLengthRequired(0)
        || GetSidLengthRequired(((SID *)sid)->SubAuthorityCount) > sid_space || !IsValidSid(sid)) {
      ok = 0; break;
    }
    napi_value rule;
    DWORD propagation = ((header->AceFlags & NO_PROPAGATE_INHERIT_ACE) ? 1 : 0)
      | ((header->AceFlags & INHERIT_ONLY_ACE) ? 2 : 0);
    ok = napi_create_object(env, &rule) == napi_ok && sid_value(env, rule, "sid", sid)
      && boolean(env, rule, "inherited", header->AceFlags & INHERITED_ACE)
      && boolean(env, rule, "allow", header->AceType == ACCESS_ALLOWED_ACE_TYPE)
      && number(env, rule, "rights", ace->Mask) && number(env, rule, "propagation", propagation)
      && napi_set_element(env, rules, i, rule) == napi_ok;
  }
  if (ok) ok = property(env, *result, "rules", rules);
  LocalFree(descriptor);
  return ok;
}
static napi_value inspect(napi_env env, napi_callback_info info) {
  napi_value args[2], result = NULL;
  size_t argc = 2;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 1) return fail(env);
  wchar_t *path = path_argument(env, args[0]);
  wchar_t *directory = argc > 1 ? path_argument(env, args[1]) : NULL;
  TOKEN_USER *user = current_user();
  int reparse, parents;
  int ok = path != NULL && (argc < 2 || directory != NULL) && user != NULL && ancestors(path, &reparse, &parents);
  if (ok && reparse) {
    ok = napi_create_object(env, &result) == napi_ok && boolean(env, result, "reparse", 1);
  } else if (ok) {
    ok = read_acl(env, path, user->User.Sid, parents, &result);
    if (ok && directory != NULL) {
      napi_value root;
      int root_reparse, root_parents;
      ok = ancestors(directory, &root_reparse, &root_parents);
      if (ok && root_reparse) {
        ok = napi_create_object(env, &root) == napi_ok && boolean(env, root, "reparse", 1);
      } else if (ok) {
        ok = read_acl(env, directory, user->User.Sid, root_parents, &root);
      }
      if (ok) ok = property(env, result, "directory", root);
    }
  }
  free(path); free(directory); free(user);
  return ok ? result : fail(env);
}
static napi_value secure(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  size_t argc = 1;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1) return fail(env);
  wchar_t *path = path_argument(env, args[0]);
  TOKEN_USER *user = current_user();
  int reparse, parents;
  int ok = path != NULL && user != NULL && ancestors(path, &reparse, &parents) && !reparse && parents;
  PACL acl = NULL;
  if (ok) {
    DWORD size = (DWORD)(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD)) + GetLengthSid(user->User.Sid);
    acl = malloc(size);
    ok = acl != NULL && InitializeAcl(acl, size, ACL_REVISION)
      && AddAccessAllowedAceEx(acl, ACL_REVISION, 0, FILE_ALL_ACCESS, user->User.Sid)
      && SetNamedSecurityInfoW(path, SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        user->User.Sid, NULL, acl, NULL) == ERROR_SUCCESS;
  }
  free(acl); free(user); free(path);
  if (!ok || napi_get_undefined(env, &result) != napi_ok) return fail(env);
  return result;
}
static napi_value replace(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t argc = 2;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2) return fail(env);
  wchar_t *source = path_argument(env, args[0]), *target = path_argument(env, args[1]);
  if (source == NULL || target == NULL) { free(source); free(target); return fail(env); }
  DWORD error = MoveFileExW(source, target, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) ? 0 : GetLastError();
  free(source); free(target);
  if (napi_create_uint32(env, error, &result) != napi_ok) return fail(env);
  return result;
}
NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"inspect", NULL, inspect, NULL, NULL, NULL, napi_default, NULL},
    {"secure", NULL, secure, NULL, NULL, NULL, napi_default, NULL},
    {"replace", NULL, replace, NULL, NULL, NULL, napi_default, NULL}
  };
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) return NULL;
  return exports;
}
#else
/* The Windows capability is never selected on POSIX. */
NAPI_MODULE_INIT() { return exports; }
#endif
