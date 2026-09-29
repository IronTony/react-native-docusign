# Gson fills com.docusign.esign.model fields by reflection, and DocuSign's
# sdk-esign-api JAR ships no keep rules. Keeping the whole esign package
# fails R8 on the missing org.apache.oltu classes, so only the models.
-keep class com.docusign.esign.model.** { *; }

# DocuSignError.native.domain carries the Android exception class name.
# Keeps this module's names readable when the app obfuscates.
-keepnames class expo.modules.docusign.**
