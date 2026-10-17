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

import com.hmdm.notification.PushService;
import com.hmdm.persistence.DeviceDAO;
import com.hmdm.persistence.domain.Device;
import com.hmdm.rest.json.Response;
import com.hmdm.security.SecurityException;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import io.swagger.annotations.Authorization;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.inject.Inject;
import javax.inject.Singleton;
import javax.ws.rs.GET;
import javax.ws.rs.POST;
import javax.ws.rs.Path;
import javax.ws.rs.PathParam;
import javax.ws.rs.Produces;
import javax.ws.rs.core.MediaType;

/**
 * <p>Lets the panel ask a device for a screenshot and show the latest one.</p>
 *
 * <p>Asking sends a {@value #PUSH_TYPE} push message, which the launcher passes on to the apps on the
 * device; an app that handles it (DonationTap) captures its screen and uploads it to
 * {@link ScreenshotUploadResource}.</p>
 */
@Singleton
@Path("/private/screenshot")
@Api(tags = {"Device screenshot"}, authorizations = {@Authorization("Bearer Token")})
public class DeviceScreenshotResource {

    private static final Logger logger = LoggerFactory.getLogger(DeviceScreenshotResource.class);

    static final String PUSH_TYPE = "dt.screenshot";

    private DeviceDAO deviceDAO;
    private PushService pushService;
    private ScreenshotStore screenshotStore;

    /**
     * <p>A constructor required by Swagger.</p>
     */
    public DeviceScreenshotResource() {
    }

    @Inject
    public DeviceScreenshotResource(DeviceDAO deviceDAO, PushService pushService, ScreenshotStore screenshotStore) {
        this.deviceDAO = deviceDAO;
        this.pushService = pushService;
        this.screenshotStore = screenshotStore;
    }

    @ApiOperation(value = "Get the latest screenshot of a device", response = ScreenshotStore.Screenshot.class)
    @GET
    @Path("/{id}")
    @Produces(MediaType.APPLICATION_JSON)
    public Response getScreenshot(@PathParam("id") @ApiParam("Device ID") Integer id) {
        try {
            // Checks that the user can see this device
            Device device = this.deviceDAO.getDeviceById(id);
            if (device == null) {
                return Response.DEVICE_NOT_FOUND_ERROR();
            }
            return Response.OK(this.screenshotStore.get(device.getId()));
        } catch (SecurityException e) {
            return Response.PERMISSION_DENIED();
        } catch (Exception e) {
            logger.error("Failed to get the screenshot of device #{}", id, e);
            return Response.INTERNAL_ERROR();
        }
    }

    @ApiOperation(value = "Ask a device for a new screenshot")
    @POST
    @Path("/{id}/request")
    @Produces(MediaType.APPLICATION_JSON)
    public Response requestScreenshot(@PathParam("id") @ApiParam("Device ID") Integer id) {
        try {
            Device device = this.deviceDAO.getDeviceById(id);
            if (device == null) {
                return Response.DEVICE_NOT_FOUND_ERROR();
            }
            this.pushService.sendSimpleMessage(device.getId(), PUSH_TYPE);
            return Response.OK();
        } catch (SecurityException e) {
            return Response.PERMISSION_DENIED();
        } catch (Exception e) {
            logger.error("Failed to ask device #{} for a screenshot", id, e);
            return Response.INTERNAL_ERROR();
        }
    }
}
