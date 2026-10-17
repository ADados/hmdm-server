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
import com.hmdm.persistence.domain.Device;
import com.hmdm.rest.json.Response;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

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
import java.util.Base64;

/**
 * <p>Receives a screenshot from an app on a device, after the panel asked for one with a
 * {@value DeviceScreenshotResource#PUSH_TYPE} push message (see {@link DeviceScreenshotResource}).</p>
 *
 * <p>Signed like {@link TerminalStatusResource}: an HMAC-SHA256 of the raw body keyed with the device's
 * {@value TerminalStatusResource#TOKEN_SETTING} application setting.</p>
 *
 * <pre>
 * POST /rest/public/screenshot/{deviceNumber}
 * X-Terminal-Signature: hex(HMAC-SHA256(token, body))
 * {"ts": 1791136337000, "image": "base64 JPEG"}
 * </pre>
 */
@Singleton
@Path("/public/screenshot")
@Api(tags = {"Device screenshot"})
public class ScreenshotUploadResource {

    private static final Logger logger = LoggerFactory.getLogger(ScreenshotUploadResource.class);

    private static final long MAX_CLOCK_SKEW_MS = 10 * 60 * 1000L;
    private static final int MAX_IMAGE_BYTES = 3 * 1024 * 1024;
    private static final String INVALID_REQUEST = "Invalid screenshot request";

    private UnsecureDAO unsecureDAO;
    private ScreenshotStore screenshotStore;
    private final ObjectMapper objectMapper = new ObjectMapper();

    /**
     * <p>A constructor required by Swagger.</p>
     */
    public ScreenshotUploadResource() {
    }

    @Inject
    public ScreenshotUploadResource(UnsecureDAO unsecureDAO, ScreenshotStore screenshotStore) {
        this.unsecureDAO = unsecureDAO;
        this.screenshotStore = screenshotStore;
    }

    @ApiOperation(
            value = "Upload a screenshot from an app",
            notes = "Signed with the device's " + TerminalStatusResource.TOKEN_SETTING + " application setting",
            response = Response.class
    )
    @POST
    @Path("/{number}")
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces(MediaType.APPLICATION_JSON)
    public Response upload(@PathParam("number") @ApiParam("Device number") String number,
                           @HeaderParam(TerminalStatusResource.SIGNATURE_HEADER) String signature,
                           String body) {
        try {
            Device device = this.unsecureDAO.getDeviceByNumber(number);
            if (device == null) {
                logger.warn("Screenshot for unknown device {}", number);
                return Response.DEVICE_NOT_FOUND_ERROR();
            }

            String token = TerminalStatusResource.findToken(this.unsecureDAO, device);
            if (token == null || token.isEmpty()) {
                logger.warn("Screenshot rejected for {}: no {} application setting", number, TerminalStatusResource.TOKEN_SETTING);
                return Response.PERMISSION_DENIED();
            }
            if (signature == null || !MessageDigest.isEqual(
                    TerminalStatusResource.hmacSha256(token, body).getBytes(StandardCharsets.US_ASCII),
                    signature.toLowerCase().getBytes(StandardCharsets.US_ASCII))) {
                logger.warn("Screenshot rejected for {}: bad signature", number);
                return Response.PERMISSION_DENIED();
            }

            JsonNode request = objectMapper.readTree(body);
            long ts = request.path("ts").asLong(0);
            if (Math.abs(System.currentTimeMillis() - ts) > MAX_CLOCK_SKEW_MS) {
                logger.warn("Screenshot rejected for {}: timestamp {} out of range", number, ts);
                return Response.ERROR(INVALID_REQUEST);
            }

            String image = request.path("image").asText("");
            byte[] jpeg;
            try {
                jpeg = Base64.getDecoder().decode(image);
            } catch (IllegalArgumentException e) {
                return Response.ERROR(INVALID_REQUEST);
            }
            // Only JPEGs, so the panel never renders anything else from a data: URL
            if (jpeg.length < 3 || jpeg.length > MAX_IMAGE_BYTES
                    || (jpeg[0] & 0xff) != 0xff || (jpeg[1] & 0xff) != 0xd8 || (jpeg[2] & 0xff) != 0xff) {
                logger.warn("Screenshot rejected for {}: not a JPEG or too large ({} bytes)", number, jpeg.length);
                return Response.ERROR(INVALID_REQUEST);
            }

            this.screenshotStore.put(device.getId(), ts, image);
            return Response.OK();
        } catch (Exception e) {
            logger.error("Unexpected error when processing screenshot for {}", number, e);
            return Response.INTERNAL_ERROR();
        }
    }
}
