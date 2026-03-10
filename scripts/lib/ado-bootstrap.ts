export interface AzureRemoteInfo {
  organizationUrl: string;
  project: string;
  repositoryName: string;
}

export function parseAzureDevOpsRemote(remoteUrl: string): AzureRemoteInfo | undefined {
  const httpsMatch = remoteUrl.match(
    /^https:\/\/(?:[^@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)$/i,
  );
  if (httpsMatch) {
    return {
      organizationUrl: `https://dev.azure.com/${httpsMatch[1]}`,
      project: httpsMatch[2],
      repositoryName: httpsMatch[3],
    };
  }

  const sshMatch = remoteUrl.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)$/i);
  if (sshMatch) {
    return {
      organizationUrl: `https://dev.azure.com/${sshMatch[1]}`,
      project: sshMatch[2],
      repositoryName: sshMatch[3],
    };
  }

  const legacyMatch = remoteUrl.match(
    /^https:\/\/([^/.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)$/i,
  );
  if (legacyMatch) {
    return {
      organizationUrl: `https://${legacyMatch[1]}.visualstudio.com`,
      project: legacyMatch[2],
      repositoryName: legacyMatch[3],
    };
  }

  return undefined;
}
