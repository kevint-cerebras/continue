import { ConfigResult, ConfigValidationError } from "@continuedev/config-yaml";

import {
  ControlPlaneClient,
  ControlPlaneSessionInfo,
} from "../control-plane/client.js";
import { getControlPlaneEnv } from "../control-plane/env.js";
import {
  BrowserSerializedContinueConfig,
  ContinueConfig,
  IContextProvider,
  IDE,
  IdeSettings,
  ILLMLogger,
} from "../index.js";
import { GlobalContext } from "../util/GlobalContext.js";

import { logger } from "../util/logger.js";
import { finalToBrowserConfig } from "./load.js";
import {
  ASSISTANTS,
  getAllDotContinueYamlFiles,
  LoadAssistantFilesOptions,
} from "./loadLocalAssistants.js";
import LocalProfileLoader from "./profile/LocalProfileLoader.js";
import PlatformProfileLoader from "./profile/PlatformProfileLoader.js";
import {
  OrganizationDescription,
  OrgWithProfiles,
  ProfileDescription,
  ProfileLifecycleManager,
  SerializedOrgWithProfiles,
} from "./ProfileLifecycleManager.js";

export type { ProfileDescription };

type ConfigUpdateFunction = (payload: ConfigResult<ContinueConfig>) => void;

export class ConfigHandler {
  controlPlaneClient: ControlPlaneClient;
  private readonly globalContext = new GlobalContext();
  private globalLocalProfileManager: ProfileLifecycleManager;

  private organizations: OrgWithProfiles[] = [];
  currentOrg: OrgWithProfiles;

  constructor(
    private readonly ide: IDE,
    private ideSettingsPromise: Promise<IdeSettings>,
    private llmLogger: ILLMLogger,
    sessionInfoPromise: Promise<ControlPlaneSessionInfo | undefined>,
  ) {
    this.ide = ide;
    this.ideSettingsPromise = ideSettingsPromise;
    this.controlPlaneClient = new ControlPlaneClient(
      sessionInfoPromise,
      ideSettingsPromise,
    );

    // This profile manager will always be available
    this.globalLocalProfileManager = new ProfileLifecycleManager(
      new LocalProfileLoader(
        ide,
        ideSettingsPromise,
        this.controlPlaneClient,
        this.llmLogger,
      ),
      this.ide,
    );

    // Just to be safe, always force a default personal org with local profile manager
    const personalOrg: OrgWithProfiles = {
      currentProfiles: [this.globalLocalProfileManager],
      profiles: [this.globalLocalProfileManager],
      ...this.PERSONAL_ORG_DESC,
    };

    this.currentOrg = personalOrg;
    this.organizations = [personalOrg];

    void this.cascadeInit();
  }

  get currentProfiles(): ProfileLifecycleManager[] {
    return this.currentOrg.currentProfiles;
  }

  get currentProfilesId(): string {
    return this.currentProfiles.map((p) => p.profileDescription.id).join(":::");
  }

  private workspaceDirs: string[] | null = null;
  async getWorkspaceId() {
    if (!this.workspaceDirs) {
      this.workspaceDirs = await this.ide.getWorkspaceDirs();
    }
    return this.workspaceDirs.join("&");
  }

  async getProfileKey(orgId: string) {
    const workspaceId = await this.getWorkspaceId();
    return `${workspaceId}:::${orgId}`;
  }

  private async cascadeInit() {
    this.workspaceDirs = null; // forces workspace dirs reload

    const orgs = await this.getOrgs();

    // Figure out selected org
    const workspaceId = await this.getWorkspaceId();
    const selectedOrgs =
      this.globalContext.get("lastSelectedOrgIdForWorkspace") ?? {};
    const currentSelection = selectedOrgs[workspaceId];

    const firstNonPersonal = orgs.find(
      (org) => org.id !== this.PERSONAL_ORG_DESC.id,
    );
    const fallback = firstNonPersonal ?? orgs[0];
    // note, ignoring case of zero orgs since should never happen

    let selectedOrg: OrgWithProfiles;
    if (!currentSelection) {
      selectedOrg = fallback;
    } else {
      const match = orgs.find((org) => org.id === currentSelection);
      if (match) {
        selectedOrg = match;
      } else {
        selectedOrg = fallback;
      }
    }

    this.globalContext.update("lastSelectedOrgIdForWorkspace", {
      ...selectedOrgs,
      [workspaceId]: selectedOrg.id,
    });

    this.organizations = orgs;
    this.currentOrg = selectedOrg;
    await this.reloadConfig();
  }

  private async getOrgs(): Promise<OrgWithProfiles[]> {
    const userId = await this.controlPlaneClient.userId;
    if (userId) {
      const orgDescs = await this.controlPlaneClient.listOrganizations();
      const personalHubOrg = await this.getPersonalHubOrg();
      const hubOrgs = await Promise.all(
        orgDescs.map((org) => this.getNonPersonalHubOrg(org)),
      );
      return [...hubOrgs, personalHubOrg];
    } else {
      return [await this.getLocalOrg()];
    }
  }

  getSerializedOrgs(): SerializedOrgWithProfiles[] {
    return this.organizations.map((org) => ({
      iconUrl: org.iconUrl,
      id: org.id,
      name: org.name,
      slug: org.slug,
      profiles: org.profiles.map((profile) => profile.profileDescription),
      selectedProfileIds: org.currentProfiles.map(
        (p) => p.profileDescription.id,
      ),
    }));
  }

  private async getHubProfiles(orgScopeId: string | null) {
    const assistants = await this.controlPlaneClient.listAssistants(orgScopeId);

    return await Promise.all(
      assistants.map(async (assistant) => {
        const profileLoader = await PlatformProfileLoader.create({
          configResult: {
            ...assistant.configResult,
            config: assistant.configResult.config,
          },
          ownerSlug: assistant.ownerSlug,
          packageSlug: assistant.packageSlug,
          iconUrl: assistant.iconUrl,
          versionSlug: assistant.configResult.config?.version ?? "latest",
          controlPlaneClient: this.controlPlaneClient,
          ide: this.ide,
          ideSettingsPromise: this.ideSettingsPromise,
          llmLogger: this.llmLogger,
          rawYaml: assistant.rawYaml,
          orgScopeId: orgScopeId,
        });

        return new ProfileLifecycleManager(profileLoader, this.ide);
      }),
    );
  }

  private async getNonPersonalHubOrg(
    org: OrganizationDescription,
  ): Promise<OrgWithProfiles> {
    const localProfiles = await this.getLocalProfiles({
      includeGlobal: false,
      includeWorkspace: true,
    });
    const profiles = [...(await this.getHubProfiles(org.id)), ...localProfiles];
    return this.rectifyProfilesForOrg(org, profiles);
  }

  private PERSONAL_ORG_DESC: OrganizationDescription = {
    iconUrl: "",
    id: "personal",
    name: "Personal",
    slug: undefined,
  };
  private async getPersonalHubOrg() {
    const localProfiles = await this.getLocalProfiles({
      includeGlobal: true,
      includeWorkspace: true,
    });
    const hubProfiles = await this.getHubProfiles(null);
    const profiles = [...hubProfiles, ...localProfiles];
    return this.rectifyProfilesForOrg(this.PERSONAL_ORG_DESC, profiles);
  }

  private async getLocalOrg() {
    const localProfiles = await this.getLocalProfiles({
      includeGlobal: true,
      includeWorkspace: true,
    });
    return this.rectifyProfilesForOrg(this.PERSONAL_ORG_DESC, localProfiles);
  }

  private async rectifyProfilesForOrg(
    org: OrganizationDescription,
    profiles: ProfileLifecycleManager[],
  ): Promise<OrgWithProfiles> {
    const profileKey = await this.getProfileKey(org.id);
    const selectedProfiles =
      this.globalContext.get("lastSelectedProfileForWorkspace") ?? {};

    const currentSelection = selectedProfiles[profileKey];

    let currentProfiles: ProfileLifecycleManager[] = [];
    if (currentSelection) {
      const profileMatches = currentSelection
        .split(":::")
        .map((id) => profiles.find((p) => p.profileDescription.id === id));
      const validProfiles: ProfileLifecycleManager[] = [];
      for (const profile of profileMatches) {
        if (profile) {
          validProfiles.push(profile);
        }
      }
      currentProfiles = validProfiles;
    }
    if (currentProfiles.length === 0) {
      currentProfiles = profiles; // fallback to all profiles selected
    }

    this.globalContext.update("lastSelectedProfileForWorkspace", {
      ...selectedProfiles,
      [profileKey]: currentProfiles
        .map((p) => p.profileDescription.id)
        .join(":::"),
    });

    return {
      ...org,
      profiles,
      currentProfiles,
    };
  }

  async getLocalProfiles(options: LoadAssistantFilesOptions) {
    /**
     * Users can define as many local assistants as they want in a `.continue/assistants` folder
     */
    const localProfiles: ProfileLifecycleManager[] = [];

    if (options.includeGlobal) {
      localProfiles.push(this.globalLocalProfileManager);
    }

    if (options.includeWorkspace) {
      const assistantFiles = await getAllDotContinueYamlFiles(
        this.ide,
        options,
        ASSISTANTS,
      );
      const profiles = assistantFiles.map((assistant) => {
        return new LocalProfileLoader(
          this.ide,
          this.ideSettingsPromise,
          this.controlPlaneClient,
          this.llmLogger,
          assistant,
        );
      });
      const localAssistantProfiles = profiles.map(
        (profile) => new ProfileLifecycleManager(profile, this.ide),
      );
      localProfiles.push(...localAssistantProfiles);
    }

    return localProfiles;
  }

  //////////////////
  // External actions that can cause a cascading config refresh
  // Should not be used internally
  //////////////////
  async refreshAll() {
    await this.cascadeInit();
  }

  // Ide settings change: refresh session and cascade refresh from the top
  async updateIdeSettings(ideSettings: IdeSettings) {
    this.ideSettingsPromise = Promise.resolve(ideSettings);
    await this.cascadeInit();
  }

  // Session change: refresh session and cascade refresh from the top
  async updateControlPlaneSessionInfo(
    sessionInfo: ControlPlaneSessionInfo | undefined,
  ) {
    this.controlPlaneClient = new ControlPlaneClient(
      Promise.resolve(sessionInfo),
      this.ideSettingsPromise,
    );
    await this.cascadeInit();
  }

  // Org id: check id validity, save selection, switch and reload
  async setSelectedOrgId(orgId: string, profileId?: string) {
    if (orgId === this.currentOrg.id) {
      return;
    }
    const org = this.organizations.find((org) => org.id === orgId);
    if (!org) {
      throw new Error(`Org ${orgId} not found`);
    }

    const workspaceId = await this.getWorkspaceId();
    const selectedOrgs =
      this.globalContext.get("lastSelectedOrgIdForWorkspace") ?? {};
    this.globalContext.update("lastSelectedOrgIdForWorkspace", {
      ...selectedOrgs,
      [workspaceId]: org.id,
    });

    this.currentOrg = org;

    if (profileId) {
      await this.setSelectedProfileIds([profileId]);
    } else {
      await this.reloadConfig();
    }
  }

  // Profile id: check id validity, save selection, switch and reload
  async setSelectedProfileIds(profileIds: string[]) {
    const profiles: ProfileLifecycleManager[] = [];
    for (const id of profileIds) {
      const profile = this.currentOrg.profiles.find(
        (profile) => profile.profileDescription.id === id,
      );
      if (!profile) {
        // throw new Error(`Profile ${id} not found in current org`);
      } else {
        profiles.push(profile);
      }
    }

    const profileKey = await this.getProfileKey(this.currentOrg.id);
    const selectedProfiles =
      this.globalContext.get("lastSelectedProfileForWorkspace") ?? {};
    this.globalContext.update("lastSelectedProfileForWorkspace", {
      ...selectedProfiles,
      [profileKey]: profileIds.join(":::"),
    });

    this.currentOrg.currentProfiles = profiles;
    await this.reloadConfig();
  }

  // Bottom level of cascade: refresh the current profile
  // IMPORTANT - must always refresh when switching profiles
  // Because of e.g. MCP singleton and docs service using things from config
  // Could improve this
  async reloadConfig() {
    for (const org of this.organizations) {
      for (const profile of org.profiles) {
        if (
          !this.currentProfiles.find(
            (p) => p.profileDescription.id === profile.profileDescription.id,
          )
        ) {
          profile.clearConfig();
        }
      }
    }

    const configResults = await Promise.all(
      this.currentProfiles.map((p) =>
        p.loadConfig(this.additionalContextProviders),
      ),
    );
    const mergedConfig = this.mergeConfigResults(configResults);
    this.notifyConfigListeners(mergedConfig);
    return mergedConfig;
  }

  // Listeners setup - can listen to current profile updates
  private notifyConfigListeners(result: ConfigResult<ContinueConfig>) {
    for (const listener of this.updateListeners) {
      listener(result);
    }
  }

  private updateListeners: ConfigUpdateFunction[] = [];

  onConfigUpdate(listener: ConfigUpdateFunction) {
    this.updateListeners.push(listener);
  }

  // Methods for loading (without reloading) config
  // Serialized for passing to GUI
  // Load for just awaiting current config load promise for the profile
  async getSerializedConfig(): Promise<
    ConfigResult<BrowserSerializedContinueConfig>
  > {
    const result = await this.loadConfig();
    if (!result.config) {
      return {
        ...result,
        config: undefined,
      };
    }
    const serializedConfig = await finalToBrowserConfig(
      result.config,
      this.ide,
    );
    return {
      ...result,
      config: serializedConfig,
    };
  }

  // ** this is super bad/slow
  mergeConfigResults(
    configs: ConfigResult<ContinueConfig>[],
  ): ConfigResult<ContinueConfig> {
    const errors: ConfigValidationError[] = [];
    const firstConfigResult = configs[0];
    const { config: firstConfig, errors: firstErrors } = firstConfigResult;
    if (!firstConfig) {
      return firstConfigResult;
    }
    const baseConfig = firstConfig;
    for (let i = 1; i < configs.length; i++) {
      errors?.push(...(configs[i].errors ?? []));
      const config = configs[i].config;
      if (config) {
        for (const model of config.modelsByRole.chat ?? []) {
          if (
            !baseConfig.modelsByRole.chat?.find((m) => m.title === model.title)
          ) {
            baseConfig.modelsByRole.chat.push(model);
          }
        }
      }
    }

    if (errors?.length) {
      logger.warn("Errors loading config: ", errors);
    }
    return {
      config: baseConfig,
      errors,
      configLoadInterrupted: false,
    };
  }

  async loadConfig(): Promise<ConfigResult<ContinueConfig>> {
    if (!this.currentProfiles.length) {
      return {
        config: undefined,
        errors: [],
        configLoadInterrupted: true,
      };
    }
    const configResults = await Promise.all(
      this.currentProfiles.map((p) =>
        p.loadConfig(this.additionalContextProviders),
      ),
    );
    const mergedConfig = this.mergeConfigResults(configResults);
    return mergedConfig;
  }

  async openConfigProfile(profileId?: string) {
    // let openProfileId = profileId || this.currentProfile?.profileDescription.id;
    if (!profileId) {
      return;
    }
    const profile = this.currentOrg.profiles.find(
      (p) => p.profileDescription.id === profileId,
    );
    if (profile?.profileDescription.profileType === "local") {
      await this.ide.openFile(profile.profileDescription.uri);
    } else {
      const env = await getControlPlaneEnv(this.ide.getIdeSettings());
      await this.ide.openUrl(`${env.APP_URL}${profileId}`);
    }
  }

  // Ancient method of adding custom providers through vs code
  private additionalContextProviders: IContextProvider[] = [];
  registerCustomContextProvider(contextProvider: IContextProvider) {
    this.additionalContextProviders.push(contextProvider);
    void this.reloadConfig();
  }
  /**
   * Retrieves the titles of additional context providers that are of type "submenu".
   *
   * @returns {string[]} An array of titles of the additional context providers that have a description type of "submenu".
   */
  getAdditionalSubmenuContextProviders(): string[] {
    return this.additionalContextProviders
      .filter((provider) => provider.description.type === "submenu")
      .map((provider) => provider.description.title);
  }
}
