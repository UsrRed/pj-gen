import { describe, expect, it } from 'vitest';
import { ghCredentialEnv } from '../src/github/githubService.js';

describe('ghCredentialEnv', () => {
  it('resets inherited helpers then delegates github.com credentials to gh', () => {
    expect(ghCredentialEnv('gh', {})).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: "!'gh' auth git-credential",
    });
  });

  it('appends after config pairs already present in the environment', () => {
    const env = ghCredentialEnv('gh', { GIT_CONFIG_COUNT: '1' });
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_2).toBe("!'gh' auth git-credential");
  });

  it('shell-quotes the gh binary path', () => {
    expect(ghCredentialEnv("/opt/my gh/it's/gh", {}).GIT_CONFIG_VALUE_1).toBe("!'/opt/my gh/it'\\''s/gh' auth git-credential");
  });
});
