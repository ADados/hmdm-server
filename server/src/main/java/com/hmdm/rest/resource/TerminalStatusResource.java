/*
 *
 * Headwind MDM: Open Source Android MDM Software
 * https://h-mdm.com
 *
 * Copyright (C) 2019 Headwind Solutions LLC (http://h-sms.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

package com.hmdm.rest.resource;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hmdm.persistence.UnsecureDAO;
import com.hmdm.persistence.domain.ApplicationSetting;
import com.hmdm.persistence.domain.Configuration;
import com.hmdm.persistence.domain.Device;
import com.hmdm.rest.json.Response;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.inject.Inject;
import javax.inject.Singleton;
import javax.ws.rs.Consumes;
import javax.ws.rs.HeaderParam;
import javax.ws.rs.POST;
import javax.ws.rs.Path;
import javax.ws.rs.PathParam;
import javax.ws.rs.Produces;
import javax.ws.rs.core.MediaType;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * <p>Lets an app on a device report its status into the device's custom properties in real time,
 * without waiting for the launcher's periodic device info upload.</p>
 *
 * <p>The request is authenticated with an HMAC-SHA256 signature of the raw body, keyed with the
 * {@value #TOKEN_SETTING} application setting of the device (device-level setting first, then the
 * configuration-level one). Devices whose configuration has no such setting can't use this endpoint.</p>
 *
 * <pre>
 * POST /rest/public/terminal-status/{deviceNumber}
 * X-Terminal-Signature: hex(HMAC-SHA256(token, body))
 * {"ts": 1791136337000, "custom": {"1": "...", "2": "..."}}
 * </pre>
 */
@Singleton
@Path("/public/terminal-status")
@Api(tags = {"Device terminal status"})
public class TerminalStatusResource {

    private static final Logger logger = LoggerFactory.getLogger(TerminalStatusResource.class);

    static final String TOKEN_SETTING = "TERMINAL_STATUS_TOKEN";
    static final String SIGNATURE_HEADER = "X-Terminal-Signature";
    // Reports older or newer than this (device clock skew + network delay) are rejected as replays
    private static final long MAX_CLOCK_SKEW_MS = 10 * 60 * 1000L;
    private static final int MAX_VALUE_LENGTH = 4000;
    private static final String INVALID_REQUEST = "Invalid terminal status request";

    private UnsecureDAO unsecureDAO;
    private final ObjectMapper objectMapper = new ObjectMapper();

    /**
     * <p>A constructor required by Swagger.</p>
     */
    public TerminalStatusResource() {
    }

    @Inject
    public TerminalStatusResource(UnsecureDAO unsecureDAO) {
        this.unsecureDAO = unsecureDAO;
    }

    @ApiOperation(
            value = "Update device custom properties from an app",
            notes = "Signed with the device's " + TOKEN_SETTING + " application setting",
            response = Response.class
    )
    @POST
    @Path("/{number}")
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces(MediaType.APPLICATION_JSON)
    public Response updateStatus(@PathParam("number") @ApiParam("Device number") String number,
                                 @HeaderParam(SIGNATURE_HEADER) String signature,
                                 String body) {
        try {
            Device device = this.unsecureDAO.getDeviceByNumber(number);
            if (device == null) {
                logger.warn("Terminal status for unknown device {}", number);
                return Response.DEVICE_NOT_FOUND_ERROR();
            }

            String token = findToken(device);
            if (token == null || token.isEmpty()) {
                logger.warn("Terminal status rejected for {}: no {} application setting", number, TOKEN_SETTING);
                return Response.PERMISSION_DENIED();
            }
            if (signature == null || !MessageDigest.isEqual(
                    hmacSha256(token, body).getBytes(StandardCharsets.US_ASCII),
                    signature.toLowerCase().getBytes(StandardCharsets.US_ASCII))) {
                logger.warn("Terminal status rejected for {}: bad signature", number);
                return Response.PERMISSION_DENIED();
            }

            JsonNode request = objectMapper.readTree(body);
            long ts = request.path("ts").asLong(0);
            if (Math.abs(System.currentTimeMillis() - ts) > MAX_CLOCK_SKEW_MS) {
                logger.warn("Terminal status rejected for {}: timestamp {} out of range", number, ts);
                return Response.ERROR(INVALID_REQUEST);
            }

            boolean changed = false;
            Iterator<Map.Entry<String, JsonNode>> fields = request.path("custom").fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> field = fields.next();
                String value = field.getValue().isNull() ? null : field.getValue().asText();
                if (value != null && value.length() > MAX_VALUE_LENGTH) {
                    return Response.ERROR(INVALID_REQUEST);
                }
                switch (field.getKey()) {
                    case "1": device.setCustom1(value); changed = true; break;
                    case "2": device.setCustom2(value); changed = true; break;
                    case "3": device.setCustom3(value); changed = true; break;
                    default:
                        return Response.ERROR(INVALID_REQUEST);
                }
            }
            if (changed) {
                this.unsecureDAO.updateDeviceCustomProperties(device.getId(), device);
            }
            return Response.OK();
        } catch (Exception e) {
            logger.error("Unexpected error when processing terminal status for {}", number, e);
            return Response.INTERNAL_ERROR();
        }
    }

    /**
     * The device-level setting overrides the configuration-level one, as for app settings sent to the device.
     */
    private String findToken(Device device) {
        String token = findSetting(this.unsecureDAO.getDeviceAppSettings(device.getId()));
        if (token == null && device.getConfigurationId() != null) {
            Configuration configuration = this.unsecureDAO.getConfigurationByIdWithAppSettings(device.getConfigurationId());
            if (configuration != null) {
                token = findSetting(configuration.getApplicationSettings());
            }
        }
        return token;
    }

    private static String findSetting(List<ApplicationSetting> settings) {
        if (settings == null) {
            return null;
        }
        for (ApplicationSetting setting : settings) {
            if (TOKEN_SETTING.equals(setting.getName())) {
                return setting.getValue();
            }
        }
        return null;
    }

    static String hmacSha256(String key, String body) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] digest = mac.doFinal(body.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            hex.append(String.format("%02x", b));
        }
        return hex.toString();
    }
}
