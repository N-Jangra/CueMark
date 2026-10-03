package com.squashdb.tracker;

import android.os.Build;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Biometric")
public class BiometricPlugin extends Plugin {
    // Use BIOMETRIC_WEAK so Android face unlock implementations that are not
    // classed as strong biometrics can authenticate alongside fingerprints.
    // Android 11+ supports one prompt for either biometric or device PIN.
    // Android 9/10 reject that authenticator combination while building it.
    private int getSupportedAuthenticators() {
        int biometric = BiometricManager.Authenticators.BIOMETRIC_WEAK;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return biometric | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        }
        return biometric;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        try {
            int authenticators = getSupportedAuthenticators();
            int result = Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                ? BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE
                : BiometricManager.from(getContext()).canAuthenticate(authenticators);
            JSObject response = new JSObject();
            response.put("available", result == BiometricManager.BIOMETRIC_SUCCESS);
            response.put("code", result);
            response.put("supportsDeviceCredential", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("Biometric availability could not be checked", error);
        }
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        if (!(getActivity() instanceof FragmentActivity)) {
            call.reject("Biometric authentication requires a FragmentActivity");
            return;
        }

        FragmentActivity activity = (FragmentActivity) getActivity();
        try {
            int authenticators = getSupportedAuthenticators();
            int availability = Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                ? BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE
                : BiometricManager.from(getContext()).canAuthenticate(authenticators);
            if (availability != BiometricManager.BIOMETRIC_SUCCESS) {
                call.reject("No supported biometric or device credential is available");
                return;
            }

            String reason = call.getString("reason", "Unlock SquashDB");
            BiometricPrompt prompt = new BiometricPrompt(activity,
                ContextCompat.getMainExecutor(activity),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        JSObject response = new JSObject();
                        response.put("success", true);
                        call.resolve(response);
                    }

                    @Override
                    public void onAuthenticationError(int errorCode, CharSequence errString) {
                        call.reject(errString == null ? "Authentication failed" : errString.toString());
                    }

                    @Override
                    public void onAuthenticationFailed() {
                        // The system prompt remains open for retry; resolve/reject only
                        // when Android reports success or a terminal error.
                    }
                }
            );
            BiometricPrompt.PromptInfo.Builder builder = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("Unlock SquashDB")
                .setSubtitle(reason)
                .setAllowedAuthenticators(authenticators);
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                // On older Android, a biometric prompt cannot also show device PIN.
                builder.setNegativeButtonText("Cancel");
            }
            prompt.authenticate(builder.build());
        } catch (Exception error) {
            call.reject("Biometric prompt could not be started", error);
        }
    }
}
