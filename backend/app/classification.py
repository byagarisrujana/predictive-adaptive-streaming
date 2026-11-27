
import pandas as pd
from sklearn.preprocessing import OrdinalEncoder
from sklearn.naive_bayes import CategoricalNB

# 1. Load the Play Tennis dataset
data = {
    'Outlook': [
        'Sunny', 'Sunny', 'Overcast', 'Rain',
        'Rain', 'Rain', 'Overcast', 'Sunny',
        'Sunny', 'Rain', 'Sunny', 'Overcast',
        'Overcast', 'Rain'
    ],
    'Temperature': [
        'Hot', 'Hot', 'Hot', 'Mild',
        'Cool', 'Cool', 'Cool', 'Mild',
        'Cool', 'Mild', 'Mild', 'Mild',
        'Hot', 'Mild'
    ],
    'Humidity': [
        'High', 'High', 'High', 'High',
        'Normal', 'Normal', 'Normal', 'High',
        'Normal', 'Normal', 'Normal', 'High',
        'Normal', 'High'
    ],
    'Wind': [
        'Weak', 'Strong', 'Weak', 'Weak',
        'Weak', 'Strong', 'Strong', 'Weak',
        'Weak', 'Weak', 'Strong', 'Strong',
        'Weak', 'Strong'
    ],
    'Play Tennis': [
        'No', 'No', 'Yes', 'Yes',
        'Yes', 'No', 'Yes', 'No',
        'Yes', 'Yes', 'Yes', 'Yes',
        'Yes', 'No'
    ]
}

df = pd.DataFrame(data)

print("Play Tennis Dataset:")
print(df)

# 2. Separate input attributes and target class
X = df.drop('Play Tennis', axis=1)
y = df['Play Tennis']

# 3. Calculate prior probabilities
print("\nPrior Probabilities:")
print(y.value_counts(normalize=True))

# 4. Calculate conditional probabilities
print("\nConditional Probabilities:")

for column in X.columns:
    print("\n", column)
    print(pd.crosstab(X[column], y, normalize='columns'))

# Encode categorical input data
encoder = OrdinalEncoder()
X_encoded = encoder.fit_transform(X)

# Encode target class
y_encoded = y.map({'No': 0, 'Yes': 1})

# 5. Apply Categorical Naive Bayes
model = CategoricalNB()
model.fit(X_encoded, y_encoded)

# 6. Predict for the given input
test_data = pd.DataFrame({
    'Outlook': ['Sunny'],
    'Temperature': ['Cool'],
    'Humidity': ['High'],
    'Wind': ['Strong']
})

test_encoded = encoder.transform(test_data)

prediction = model.predict(test_encoded)
probabilities = model.predict_proba(test_encoded)

# Display predicted class
result = {0: 'No', 1: 'Yes'}

print("\nPrediction:")
print("Predicted Play Tennis:", result[prediction[0]])

print("\nClass Probabilities:")
for i, class_name in enumerate(model.classes_):
    print(result[class_name], ":", probabilities[0][i])
