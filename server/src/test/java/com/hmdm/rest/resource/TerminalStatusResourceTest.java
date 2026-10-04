package com.hmdm.rest.resource;

import com.hmdm.persistence.UnsecureDAO;
import com.hmdm.persistence.domain.ApplicationSetting;
import com.hmdm.persistence.domain.Configuration;
import com.hmdm.persistence.domain.Device;
import com.hmdm.rest.json.Response;
import com.hmdm.rest.json.Response.ResponseStatus;
import org.junit.Before;
import org.junit.Test;

import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.mockito.Matchers.any;
import static org.mockito.Matchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

public class TerminalStatusResourceTest {

    private static final String TOKEN = "s3cret-token";

    private UnsecureDAO dao;
    private Device device;
    private TerminalStatusResource resource;

    @Before
    public void setUp() {
        dao = mock(UnsecureDAO.class);
        device = new Device();
        device.setId(7);
        device.setNumber("kiosk1");
        device.setConfigurationId(3);
        when(dao.getDeviceByNumber("kiosk1")).thenReturn(device);
        when(dao.getDeviceAppSettings(7)).thenReturn(Collections.emptyList());
        resource = new TerminalStatusResource(dao);
    }

    private void configureToken(String value) {
        ApplicationSetting setting = new ApplicationSetting();
        setting.setName(TerminalStatusResource.TOKEN_SETTING);
        setting.setValue(value);
        Configuration configuration = new Configuration();
        configuration.setApplicationSettings(Collections.singletonList(setting));
        when(dao.getConfigurationByIdWithAppSettings(3)).thenReturn(configuration);
    }

    private static String body(long ts) {
        return "{\"ts\":" + ts + ",\"custom\":{\"1\":\"{\\\"type\\\":\\\"dt.terminal\\\",\\\"status\\\":\\\"CONNECTED\\\"}\",\"2\":\"donation\"}}";
    }

    @Test
    public void validSignatureUpdatesCustomFields() throws Exception {
        configureToken(TOKEN);
        String body = body(System.currentTimeMillis());

        Response response = resource.updateStatus("kiosk1", TerminalStatusResource.hmacSha256(TOKEN, body), body);

        assertEquals(ResponseStatus.OK, response.getStatus());
        assertEquals("{\"type\":\"dt.terminal\",\"status\":\"CONNECTED\"}", device.getCustom1());
        assertEquals("donation", device.getCustom2());
        assertNull(device.getCustom3());
        verify(dao).updateDeviceCustomProperties(7, device);
    }

    @Test
    public void deviceLevelTokenOverridesConfiguration() throws Exception {
        configureToken("configuration-token");
        ApplicationSetting deviceSetting = new ApplicationSetting();
        deviceSetting.setName(TerminalStatusResource.TOKEN_SETTING);
        deviceSetting.setValue(TOKEN);
        when(dao.getDeviceAppSettings(7)).thenReturn(Collections.singletonList(deviceSetting));
        String body = body(System.currentTimeMillis());

        Response response = resource.updateStatus("kiosk1", TerminalStatusResource.hmacSha256(TOKEN, body), body);

        assertEquals(ResponseStatus.OK, response.getStatus());
    }

    @Test
    public void wrongSignatureIsRejected() throws Exception {
        configureToken(TOKEN);
        String body = body(System.currentTimeMillis());

        Response response = resource.updateStatus("kiosk1", TerminalStatusResource.hmacSha256("other", body), body);

        assertEquals(ResponseStatus.ERROR, response.getStatus());
        verify(dao, never()).updateDeviceCustomProperties(anyInt(), any(Device.class));
    }

    @Test
    public void missingTokenSettingDisablesEndpoint() throws Exception {
        when(dao.getConfigurationByIdWithAppSettings(3)).thenReturn(new Configuration());
        String body = body(System.currentTimeMillis());

        Response response = resource.updateStatus("kiosk1", TerminalStatusResource.hmacSha256("any-key", body), body);

        assertEquals(ResponseStatus.ERROR, response.getStatus());
        verify(dao, never()).updateDeviceCustomProperties(anyInt(), any(Device.class));
    }

    @Test
    public void staleTimestampIsRejected() throws Exception {
        configureToken(TOKEN);
        String body = body(System.currentTimeMillis() - 60 * 60 * 1000L);

        Response response = resource.updateStatus("kiosk1", TerminalStatusResource.hmacSha256(TOKEN, body), body);

        assertEquals(ResponseStatus.ERROR, response.getStatus());
        verify(dao, never()).updateDeviceCustomProperties(anyInt(), any(Device.class));
    }

    @Test
    public void unknownDeviceIsRejected() throws Exception {
        String body = body(System.currentTimeMillis());

        Response response = resource.updateStatus("nope", TerminalStatusResource.hmacSha256(TOKEN, body), body);

        assertEquals(ResponseStatus.ERROR, response.getStatus());
    }

    @Test
    public void unknownCustomFieldIsRejected() throws Exception {
        configureToken(TOKEN);
        String body = "{\"ts\":" + System.currentTimeMillis() + ",\"custom\":{\"4\":\"x\"}}";

        Response response = resource.updateStatus("kiosk1", TerminalStatusResource.hmacSha256(TOKEN, body), body);

        assertEquals(ResponseStatus.ERROR, response.getStatus());
        verify(dao, never()).updateDeviceCustomProperties(anyInt(), any(Device.class));
    }
}
