#!/bin/bash

# Uses `node` instead of `jq` so this script works without any extra system dependency.
main (){
    config=$(aio config ls --json)

    echo "$config" | node -e '
      let data = "";
      process.stdin.on("data", (chunk) => { data += chunk; });
      process.stdin.on("end", () => {
        const config = JSON.parse(data);
        const services = config.project?.workspace?.details?.services ?? [];

        if (!services.some((s) => s.code === "AdobeIOManagementAPISDK")) {
          console.error("Error: I/O Management API was not found in your workspace.");
          process.exit(1);
        }

        const credentials = config.project?.workspace?.details?.credentials ?? [];
        const s2sCredential = credentials.find((c) => c.integration_type === "oauth_server_to_server");
        const ctx = s2sCredential?.name?.toLowerCase();
        const ims = config.ims?.contexts?.[ctx] ?? {};
        const asArray = (value) => (typeof value === "string" ? JSON.parse(value) : (value ?? []));
        const clientSecrets = asArray(ims.client_secrets);
        const scopes = asArray(ims.scopes);

        console.log(`CLIENTID:                     ${ims.client_id ?? ""}`);
        console.log(`CLIENTSECRET:                 ${clientSecrets[0] ?? ""}`);
        console.log(`TECHNICALACCID:               ${ims.technical_account_id ?? ""}`);
        console.log(`TECHNICALACCEMAIL:            ${ims.technical_account_email ?? ""}`);
        console.log(`IMSORGID:                     ${ims.ims_org_id ?? ""}`);
        console.log(`SCOPES:                       ${scopes.join(",")}`);
        console.log(`AIO_RUNTIME_NAMESPACE:        ${config.runtime?.namespace ?? ""}`);
        console.log(`AIO_RUNTIME_AUTH:             ${config.runtime?.auth ?? ""}`);
        console.log(`AIO_PROJECT_ID:               ${config.project?.id ?? ""}`);
        console.log(`AIO_PROJECT_NAME:             ${config.project?.name ?? ""}`);
        console.log(`AIO_PROJECT_ORG_ID:           ${config.project?.org?.id ?? ""}`);
        console.log(`AIO_PROJECT_WORKSPACE_ID:     ${config.project?.workspace?.id ?? ""}`);
        console.log(`AIO_PROJECT_WORKSPACE_NAME:   ${config.project?.workspace?.name ?? ""}`);
        console.log(`AIO_PROJECT_WORKSPACE_DETAILS_SERVICES:   ${JSON.stringify(services)}`);
      });
    '
}

main
